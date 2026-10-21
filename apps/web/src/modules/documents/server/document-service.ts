import { Clock, Context, Duration, Effect, Layer, PubSub, Schedule, Schema, Stream } from "effect";
import { Fragment, Node } from "@tiptap/pm/model";
import { Step, Transform } from "@tiptap/pm/transform";
import { uuidv7 } from "uuidv7";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import { attachmentWriter } from "~/modules/attachments/server/service.ts";
import { GenerationFence } from "~/modules/chat/server/generation-fence.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { StorageQuota } from "~/modules/limits/server/storage.ts";
import { and, eq, inArray } from "drizzle-orm";
import { attachmentBlobs, attachments as attachmentRows } from "~/db/schema/index.ts";
import { originatingSessionEligible } from "~/modules/auth/server/account-eligibility.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db, type DbTx } from "~/server/db.ts";
import {
  adoptIds,
  blockIdOf,
  ensureIds,
  findBlocks,
  plannedIds,
  withFreshIds,
} from "../editor/block-ids.ts";
import { PENDING_INTENT_CHARS } from "../editor/pending.ts";
import {
  applyTreeEdit,
  checkSeen,
  fitBlocks,
  resolveRange,
  type SeenBlocks,
  type TreeEdit,
} from "../editor/tree-edit.ts";
import { blockHash } from "../editor/tree.ts";
import { overCap } from "../editor/limits.ts";
import { presenceUser } from "../presence-user.ts";
import { detachedThreads, quoteRange } from "../editor/comments.ts";
import { squareTables } from "../editor/tables.ts";
import { CALLOUT_KINDS } from "../editor/blocks.ts";
import {
  documentSchema,
  parseMarkdown,
  replaceDifference,
  writeDifference,
} from "../editor/markdown.ts";
import {
  CommentInput,
  CreateDocumentInput,
  DeleteCommentInput,
  DOCUMENT_LIMITS,
  DocumentNotAvailable,
  DocumentRejected,
  documentImagePath,
  IMAGE_REFUSED,
  PushDocumentInput,
  type DocumentImageInput,
  ResolveThreadInput,
  type ApplyDocumentResult,
  type DocumentComment,
  type DocumentFrame,
  type DocumentPresence,
  type EditableDocument,
  type PushDocumentResult,
} from "../schema.ts";
import { DocumentRepo, type DocumentOwner } from "./document-repo.ts";
import { groupVersions, type DocumentVersion } from "./versions.ts";
import { placeImported, type ImportedText } from "./word-import.ts";
import type { TreeNode } from "~/modules/word/server/document-tree.ts";
import {
  commentDeletion,
  documentLocks,
  lockProjectForEditing,
  notifyDocumentChanged,
  personComment,
  threadResolution,
} from "./live-shared.ts";

export type DocumentWriteGuard<E = never, R = never> = (tx: DbTx) => Effect.Effect<unknown, E, R>;
/** One assistant call on comments: `thread` names an existing one, else `target` starts one. */
export interface AssistantCommentInput {
  documentId: string;
  thread?: string | undefined;
  target?: string | undefined;
  quote?: string | undefined;
  body?: string | undefined;
}
type DocumentError = DocumentNotAvailable | DocumentRejected;

/**
 * Steps are folded into the snapshot only past both of these, so an editor
 * that was offline for weeks can still rebase what it typed.
 */
const COMPACT_STEPS = 2_000;
const RETAIN_STEPS = Duration.days(30);
/** An entry nobody watches is dropped after this; the database still has it all. */
const IDLE = Duration.minutes(1);
/** How often an open feed confirms its reader still has access. */
const ACCESS_RECHECK = Duration.seconds(30);
/** Cards and lists follow a person's typing through `document.changed` at most this often. */
const CHANGED_THROTTLE = Duration.seconds(1);
/** The collab client id of every model write, and of the server's own repairs. */
const MODEL_CLIENT = "model";
const SERVER_CLIENT = "server";
/**
 * A person's collab id as stored and relayed: theirs, scoped by who sent it,
 * so nobody can take over another's, nor the server's own `model`, `server`
 * and `app:<client>` ids. Each person's own feed sees their ids unscoped.
 */
const personClient = (userId: string, clientId: string) => `${userId}:${clientId}`;
const asSeenBy = (userId: string) => {
  const prefix = `${userId}:`;
  const id = (clientId: string) =>
    clientId.startsWith(prefix) ? clientId.slice(prefix.length) : clientId;
  return (frame: DocumentFrame): DocumentFrame =>
    frame.type === "steps"
      ? { ...frame, clientIds: frame.clientIds.map(id) }
      : frame.type === "presence"
        ? { ...frame, clientId: id(frame.clientId) }
        : frame;
};

interface KeptStep {
  readonly json: Record<string, unknown>;
  readonly clientId: string;
  readonly createdAt: number;
}
interface Entry {
  /** The tree at `revision`. Moves only once a write has committed. */
  doc: Node;
  /** The stored snapshot and every step after it, so any editor since can catch up. */
  snapshot: Node;
  snapshotRevision: number;
  steps: KeptStep[];
  revision: number;
  readonly presence: Map<string, DocumentPresence>;
  /**
   * Open feeds per client id. A caret is kept only while its feed is open, so
   * a push landing after its tab left cannot leave one behind for good.
   */
  readonly feeds: Map<string, number>;
  comments: DocumentComment[];
  readonly frames: PubSub.PubSub<DocumentFrame>;
  readonly conversationId: string | null;
  readonly projectId: string | null;
  subscribers: number;
  touched: number;
  changedPending: boolean;
}

interface Author {
  origin: "user" | "model";
  userId: string;
  clientId: string;
}
/** What one committed write did, for `settle` to bring the entry along. */
interface Stored {
  document: EditableDocument;
  doc: Node;
  steps: KeptStep[];
  compacted: { snapshot: Node; revision: number } | null;
}

const decode =
  <S extends Schema.Top>(schema: S, reason: string) =>
  (input: S["Type"]) =>
    Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => new DocumentRejected({ reason })),
    );
/** Steps rebuilt from JSON and applied in order; any that does not fit the schema refuses all. */
const applySteps = (
  doc: Node,
  json: ReadonlyArray<Record<string, unknown>>,
  { checked = false }: { checked?: boolean } = {},
) =>
  Effect.try({
    try: () => {
      let next = doc;
      const steps = json.map((each) => {
        const step = Step.fromJSON(documentSchema, each);
        const result = step.apply(next);
        if (!result.doc) throw new Error(result.failed ?? "step failed");
        next = result.doc;
        return step;
      });
      // A step checks content only where its slice meets the tree, so an empty
      // collapsible section or a callout holding bare text applied. New steps
      // check the whole result once per batch; stored ones replay as they were.
      if (checked && next.childCount) next.check();
      return { doc: next, steps };
    },
    catch: () => new DocumentRejected({ reason: "invalid document step" }),
  });
/**
 * One model edit written while its arguments stream. It owns the blocks it
 * wrote, by ID, and the hash each had when it wrote it: a person changing
 * one of them ends the preview. `original` is what it replaced, put back if
 * no call claims it.
 */
export interface LiveEdit {
  readonly userId: string;
  readonly documentId: string;
  readonly edit: Extract<TreeEdit, { kind: "blocks" }>;
  readonly seen: SeenBlocks | null;
  owned: string[];
  written: Map<string, string>;
  original: Node[] | null;
  broken: boolean;
  /** Set when the preview stopped because it would strip open threads of their text. */
  detached: string[] | null;
  readonly allowDetach: boolean;
}
/** Why a model edit that would strip open threads of all their text landed nothing. */
const detachRefusal = (threads: ReadonlyArray<string>) => ({
  outcome: "anchors_affected" as const,
  message: `Nothing changed: this would remove all the text open comment thread${threads.length > 1 ? "s" : ""} ${threads.slice(0, 5).join(", ")} ${threads.length > 1 ? "are" : "is"} on. Narrow it with find so some of those words stay, or ask in the thread. Resend with allowDetach only when a person asked for that text to go (the comment you are answering counts); the thread then stays open without its text, so say in it what you changed.`,
});

/** Why a streamed creation stopped: someone wrote in the document while it streamed. */
export const EDITED_MEANWHILE = "someone edited the document while it was being written";

/** The stored revision moved without this process: rebuild the entry from storage. */
class StaleEntry extends Schema.TaggedError<StaleEntry>()("StaleEntry", {}) {}

/** A value the schema's attributes hold: anything else, an object above all, is a client's invention. */
const plainValue = (value: unknown) =>
  value === null || ["string", "number", "boolean"].includes(typeof value);
/** Attributes the schema types loosely but the model's view and the editor rely on. */
const wellTyped = (node: Node) => {
  for (const [name, value] of Object.entries(node.attrs)) {
    // A table cell's column widths are the one list an attribute holds: a
    // number for each column it spans, and no more.
    const span = typeof node.attrs.colspan === "number" ? node.attrs.colspan : 1;
    const widths =
      name === "colwidth" &&
      Array.isArray(value) &&
      value.length <= Math.min(span, 64) &&
      value.every((each) => typeof each === "number");
    if (!plainValue(value) && !widths) return false;
  }
  for (const mark of node.marks) if (!Object.values(mark.attrs).every(plainValue)) return false;
  const { level, start, checked } = node.attrs as Record<string, unknown>;
  switch (node.type.name) {
    case "heading":
      return typeof level === "number" && Number.isInteger(level) && level >= 1 && level <= 6;
    case "orderedList":
      return typeof start === "number" && Number.isInteger(start) && start >= 0;
    case "taskItem":
      return typeof checked === "boolean";
    case "callout":
      return (CALLOUT_KINDS as ReadonlyArray<unknown>).includes(node.attrs.kind);
    default:
      return true;
  }
};
/** Refuses a tree a client invented or one past the size limits, for every author. */
const withinTreeCap = (doc: Node) => {
  let malformed = false;
  doc.descendants((node) => {
    malformed ||= !wellTyped(node);
    return !malformed;
  });
  if (malformed) return Effect.fail(new DocumentRejected({ reason: "invalid document update" }));
  const over = overCap(doc);
  return over ? Effect.fail(new DocumentRejected({ reason: over })) : Effect.void;
};
/** The owned blocks of a live edit as one sibling range, or null if a person touched them. */
const ownedRange = (doc: Node, live: LiveEdit) => {
  const found = live.owned.map((id) => findBlocks(doc, id));
  if (found.some((each) => each.length !== 1)) return null;
  const nodes = found.map((each) => each[0]!);
  const $first = doc.resolve(nodes[0]!.position);
  const parent = $first.parent;
  const startIndex = $first.index();
  for (const [offset, { node, position }] of nodes.entries()) {
    const $node = doc.resolve(position);
    if ($node.parent !== parent || $node.index() !== startIndex + offset) return null;
    if (live.written.get(blockIdOf(node)!) !== blockHash(node)) return null;
  }
  const last = nodes.at(-1)!;
  return {
    parent,
    startIndex,
    endIndex: startIndex + nodes.length,
    from: nodes[0]!.position,
    to: last.position + last.node.nodeSize,
  };
};

/** Markdown, then a planned section per outline entry, with every block given an ID. */
const buildDocument = (content: string, outline: ReadonlyArray<string> = []) =>
  Effect.try({
    try: () => parseMarkdown(content),
    catch: () => new DocumentRejected({ reason: "this Markdown could not be read as a document" }),
  }).pipe(Effect.map((parsed) => withOutline(parsed, outline)));

const withOutline = (parsed: Node, outline: ReadonlyArray<string>) => {
  const pending = outline.map((intent) =>
    documentSchema.nodes.pending!.create({ intent: intent.slice(0, PENDING_INTENT_CHARS) }),
  );
  // An empty document still holds one empty paragraph to type into.
  const doc = documentSchema.nodes.doc!.createAndFill(null, [
    ...Array.from({ length: parsed.childCount }, (_, index) => parsed.child(index)),
    ...pending,
  ])!;
  return ensureIds(squareTables(new Transform(doc))).doc;
};
/** Who a document belongs to, as the image owner is read from it. */
const ownerOf = (document: Pick<EditableDocument, "projectId" | "conversationId">) =>
  document.projectId
    ? { projectId: document.projectId }
    : { conversationId: document.conversationId ?? "" };

/** A tree read from a file, as the schema builds it, every block given an ID; refused if it does not fit. */
const importedDocument = (json: TreeNode) =>
  Effect.try({
    try: () => {
      const doc = Node.fromJSON(documentSchema, json);
      doc.check();
      return ensureIds(squareTables(new Transform(doc))).doc;
    },
    catch: () => new DocumentRejected({ reason: "this file could not be read as a document" }),
  });
/**
 * Where the preview writes now: its own blocks once it has some, else the
 * target as the edit names it. Null when that cannot be told any more.
 */
const liveSpot = (doc: Node, live: LiveEdit) => {
  if (live.owned.length) return ownedRange(doc, live);
  const range = resolveRange(doc, live.edit.target, live.edit.through);
  if ("outcome" in range) return null;
  if (live.edit.position === "replace") return checkSeen(range, live.seen) ? null : range;
  const index = live.edit.position === "before" ? range.startIndex : range.endIndex;
  const at = live.edit.position === "before" ? range.from : range.to;
  return { parent: range.parent, startIndex: index, endIndex: index, from: at, to: at };
};

export class DocumentService extends Context.Service<
  DocumentService,
  {
    get(userId: string, documentId: string): Effect.Effect<EditableDocument | null>;
    list(userId: string, owner: DocumentOwner): Effect.Effect<EditableDocument[]>;
    /** Deletes a project's document; a chat's goes only with its answer. */
    remove(userId: string, documentId: string): Effect.Effect<void, DocumentError>;
    /** A new title, by anyone who may edit the document. */
    rename(
      userId: string,
      documentId: string,
      title: string,
    ): Effect.Effect<EditableDocument, DocumentError>;
    /**
     * A new document from Markdown, or from `from`, a Word file already read:
     * its images are claimed and its comments become threads of origin `file`.
     */
    create<E = never, R = never>(
      userId: string,
      input: CreateDocumentInput,
      guard?: DocumentWriteGuard<E, R>,
      from?: ImportedText,
    ): Effect.Effect<
      { outcome: "created"; document: EditableDocument; planned: string[] },
      DocumentError | E,
      R
    >;
    /** A text document's versions, newest first, for anyone who may edit it; null otherwise. */
    versions(userId: string, documentId: string): Effect.Effect<DocumentVersion[] | null>;
    /**
     * The document as it was at a listed version, as tree JSON text, for
     * anyone who may edit it; null when that revision is no longer kept.
     */
    versionAt(userId: string, documentId: string, revision: number): Effect.Effect<string | null>;
    /** The live tree, for rendering what the model reads. Null when not this person's. */
    read(
      userId: string,
      documentId: string,
    ): Effect.Effect<{
      document: EditableDocument;
      doc: Node;
      comments: ReadonlyArray<DocumentComment>;
    } | null>;
    /**
     * One model edit aimed at blocks by ID or at text in one block. A replace
     * or delete must cover only blocks `seen` holds as they are now, so a
     * person's typing since the model read is never written over.
     */
    apply<E = never, R = never>(
      userId: string,
      input: {
        documentId: string;
        edit: TreeEdit;
        seen: SeenBlocks | null;
        /** A person asked for text under open comments to go. */
        allowDetach?: boolean | undefined;
        /**
         * The person's own edit, made through a connected app: stored as theirs
         * and needing no generation, still checked against `seen`.
         */
        asPerson?: { readonly clientId: string } | undefined;
      },
      guard?: DocumentWriteGuard<E, R>,
    ): Effect.Effect<ApplyDocumentResult, DocumentError | E, R>;
    /**
     * Makes the whole document read as `markdown` and `outline`, as the
     * smallest change: what a streamed `create_document` writes into the
     * document it created.
     */
    rewrite<E = never, R = never>(
      userId: string,
      input: {
        documentId: string;
        content: string;
        outline?: ReadonlyArray<string>;
        /**
         * Refuse with `EDITED_MEANWHILE` unless the document is still at this
         * revision: a streamed creation must not overwrite what someone typed.
         */
        ifRevision?: number;
      },
      guard: DocumentWriteGuard<E, R>,
    ): Effect.Effect<EditableDocument | null, DocumentError | E, R>;
    /**
     * Hands a streamed creation's document to the project, once the call that
     * made it turns out to want it there: it streams in private until then.
     */
    moveToProject<E = never, R = never>(
      userId: string,
      documentId: string,
      projectId: string,
      guard: DocumentWriteGuard<E, R>,
    ): Effect.Effect<EditableDocument, DocumentError | E, R>;
    /**
     * Deletes a chat document an unclaimed streamed creation left behind,
     * unless someone has written in it since `ifRevision`: then it is theirs.
     */
    discard<E = never, R = never>(
      userId: string,
      documentId: string,
      guard: DocumentWriteGuard<E, R>,
      ifRevision?: number,
    ): Effect.Effect<void, DocumentError | E, R>;
    /**
     * A `blocks` edit written while it streams. `beginLive` checks the target
     * now; each `updateLive` replaces the blocks the preview owns with the
     * Markdown streamed so far (a person touching one ends it); `settleLive`
     * writes the final text under the full fence; `revertLive` puts back what
     * an unclaimed preview replaced.
     */
    beginLive(
      userId: string,
      input: {
        documentId: string;
        edit: Extract<TreeEdit, { kind: "blocks" }>;
        seen: SeenBlocks | null;
        allowDetach?: boolean | undefined;
      },
    ): Effect.Effect<LiveEdit | null>;
    updateLive<E, R>(
      live: LiveEdit,
      content: string,
      guard: DocumentWriteGuard<E, R>,
    ): Effect.Effect<boolean, DocumentError | E, R>;
    settleLive<E, R>(
      live: LiveEdit,
      content: string,
      guard: DocumentWriteGuard<E, R>,
    ): Effect.Effect<ApplyDocumentResult, DocumentError | E, R>;
    revertLive<E, R>(
      live: LiveEdit,
      guard: DocumentWriteGuard<E, R>,
    ): Effect.Effect<void, DocumentError | E, R>;
    /**
     * Claims one of the editor's own image uploads for the document and
     * returns the address its readers load it from. Anything else is refused
     * alike, so the refusal says nothing about the attachment.
     */
    addImage(userId: string, input: DocumentImageInput): Effect.Effect<string, DocumentError>;
    /** A person's editor: steps on a revision and/or its cursor. */
    push(
      userId: string,
      input: PushDocumentInput,
    ): Effect.Effect<PushDocumentResult, DocumentError>;
    /**
     * The live feed for one open editor: the steps since `revision` (or the
     * whole document when that is too old or absent), then every later step
     * and cursor. Null when the document is not the person's.
     */
    subscribe(
      userId: string,
      documentId: string,
      options: { sessionId: string; revision: number | null; clientId: string | null },
    ): Effect.Effect<Stream.Stream<DocumentFrame> | null>;
    /** Starts a thread on text the editor marked with its ID, or replies to one. */
    comment(userId: string, input: CommentInput): Effect.Effect<void, DocumentError>;
    resolveThread(userId: string, input: ResolveThreadInput): Effect.Effect<void, DocumentError>;
    deleteComment(userId: string, input: DeleteCommentInput): Effect.Effect<void, DocumentError>;
    assistantComment<E, R>(
      userId: string,
      input: AssistantCommentInput,
      guard: DocumentWriteGuard<E, R>,
    ): Effect.Effect<
      | { outcome: "commented"; thread: string }
      | { outcome: "not_found" | "ambiguous" | "invalid"; message: string },
      DocumentError | E,
      R
    >;
  }
>()("chat/documents/DocumentService") {
  static readonly layer = Layer.effect(
    DocumentService,
    Effect.gen(function* () {
      const db = yield* Db;
      const policy = yield* FeaturePolicy;
      const storage = yield* StorageQuota;
      const documents = yield* DocumentRepo;
      const attachments = yield* AttachmentRepo;
      const files = attachmentWriter(attachments, yield* BlobStore);
      const bus = yield* SyncBus;
      const scope = yield* Effect.scope;
      // One process owns every document's live state (see docs/internals/documents.md).
      const entries = new Map<string, Entry>();
      const exclusive = documentLocks();
      // A cursor moves several times a second; its label is looked up once a minute at most.
      const names = new Map<string, { name: string; at: number }>();
      const nameOf = (userId: string) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const known = names.get(userId);
          if (known && now - known.at < 60_000) return known.name;
          const name = yield* documents.userName(userId);
          names.set(userId, { name, at: now });
          return name;
        });
      const drop = (documentId: string) =>
        Effect.suspend(() => {
          const entry = entries.get(documentId);
          if (!entry) return Effect.void;
          entries.delete(documentId);
          // Ends every open feed; each editor reconnects and catches up from storage.
          return PubSub.shutdown(entry.frames);
        });
      yield* Effect.addFinalizer(() =>
        Effect.forEach([...entries.keys()], drop, { discard: true }),
      );

      /**
       * The live entry, and the document as this reader may use it. Access is
       * checked on every call, not once per entry: a project's members change,
       * and each of them reaches the same entry.
       */
      const load = (userId: string, documentId: string) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const cached = entries.get(documentId);
          if (cached) {
            const document = yield* documents.get(userId, documentId);
            if (!document) return yield* new DocumentNotAvailable({ documentId });
            cached.touched = now;
            return { entry: cached, document };
          }
          const state = yield* documents.loadState(userId, documentId);
          if (!state) return yield* new DocumentNotAvailable({ documentId });
          const snapshot = Node.fromJSON(documentSchema, state.snapshot);
          // Stored steps were checked when they arrived; one that no longer
          // applies means storage is corrupt, which is a defect.
          const { doc } = yield* applySteps(
            snapshot,
            state.steps.map((row) => row.step),
          ).pipe(Effect.orDie);
          const entry: Entry = {
            doc,
            snapshot,
            snapshotRevision: state.snapshotRevision,
            steps: state.steps.map((row) => ({
              json: row.step,
              clientId: row.clientId,
              createdAt: row.createdAt.getTime(),
            })),
            revision: state.document.revision,
            presence: new Map(),
            feeds: new Map(),
            comments: yield* documents.comments(documentId),
            frames: yield* PubSub.unbounded<DocumentFrame>(),
            conversationId: state.document.conversationId,
            projectId: state.document.projectId,
            subscribers: 0,
            touched: now,
            changedPending: false,
          };
          entries.set(documentId, entry);
          return { entry, document: state.document };
        });

      const documentChanged = notifyDocumentChanged(db, bus);
      /** A person's keystrokes would otherwise send one notification per batch. */
      const documentChangedSoon = (userId: string, documentId: string, entry: Entry) =>
        Effect.suspend(() => {
          if (entry.changedPending) return Effect.void;
          entry.changedPending = true;
          return Effect.sleep(CHANGED_THROTTLE).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                entry.changedPending = false;
                return documentChanged(
                  userId,
                  {
                    id: documentId,
                    conversationId: entry.conversationId,
                    projectId: entry.projectId,
                  },
                  true,
                );
              }),
            ),
            Effect.forkIn(scope),
            Effect.asVoid,
          );
        });

      const transaction = <A, E, R>(body: (tx: DbTx) => Effect.Effect<A, E, R>) =>
        db.transaction(body).pipe(Effect.catchTag("SqlError", Effect.die));

      /**
       * Copies the caller's image uploads to the owner of the document's files
       * when that is someone else, so an image outlives whoever added it.
       * Done before the claim's transaction, like any upload; a copy left
       * unclaimed is swept.
       */
      const planImages = (
        userId: string,
        owner: DocumentOwner | null,
        attachmentIds: ReadonlyArray<string>,
        /** A person's images take the owner's quota; the model's are kept like its files. */
        charged: boolean,
      ) =>
        Effect.gen(function* () {
          const copies = new Map<string, string>();
          if (!owner || !(yield* policy.can(userId, "documents"))) return { ownerId: null, copies };
          const ownerId = yield* documents.imageOwner(userId, owner);
          if (!ownerId || ownerId === userId) return { ownerId, copies };
          // Copied under the owner, so it is the owner's quota they take, unless stored there already.
          const images =
            charged && attachmentIds.length
              ? yield* db
                  .select({ sha256: attachmentBlobs.sha256, size: attachmentBlobs.size })
                  .from(attachmentRows)
                  .innerJoin(attachmentBlobs, eq(attachmentBlobs.id, attachmentRows.blobId))
                  .where(
                    and(
                      inArray(attachmentRows.id, [...attachmentIds]),
                      eq(attachmentRows.userId, userId),
                    ),
                  )
                  .pipe(Effect.orDie)
              : [];
          yield* storage
            .admitFor(ownerId, userId, images)
            .pipe(
              Effect.catchTag("StorageFull", (full) =>
                Effect.fail(new DocumentRejected({ reason: full.reason })),
              ),
            );
          for (const attachmentId of attachmentIds) {
            const copy = yield* files.copyImage({ userId, attachmentId, toUserId: ownerId });
            if (copy) copies.set(attachmentId, copy);
          }
          return { ownerId, copies };
        });

      /**
       * Claims each upload as planned, or nothing: the plan must still name
       * the owner, and each claim re-checks its upload under the blob lock.
       * Returns the storage keys to delete after commit, or null when refused.
       */
      const claimImages = (
        tx: DbTx,
        userId: string,
        documentId: string,
        owner: DocumentOwner,
        plan: { ownerId: string | null; copies: ReadonlyMap<string, string> },
        attachmentIds: ReadonlyArray<string>,
      ) =>
        Effect.gen(function* () {
          const { ownerId, copies } = plan;
          if (!ownerId || (yield* documents.imageOwner(userId, owner, tx)) !== ownerId) return null;
          // Locked together first, in the global order: claimed one by one in
          // the file's order, two imports of the same pictures could deadlock.
          yield* attachments.lockForClaims(tx, [...attachmentIds, ...copies.values()]);
          const spent: string[] = [];
          for (const attachmentId of attachmentIds) {
            const copy = copies.get(attachmentId);
            if (ownerId !== userId && !copy) return null;
            const claim = yield* attachments.claimForDocument(tx, {
              userId,
              documentId,
              attachmentId,
              copy: copy ? { userId: ownerId, attachmentId: copy } : undefined,
            });
            if (!claim) return null;
            spent.push(...claim.discard);
          }
          return spent;
        });

      const requireDocuments = (userId: string, tx?: DbTx) =>
        policy
          .can(userId, "documents", tx)
          .pipe(
            Effect.flatMap((allowed) =>
              allowed
                ? Effect.void
                : Effect.fail(new DocumentRejected({ reason: "documents are unavailable" })),
            ),
          );
      /**
       * Where steps old enough to fold end, once enough have piled up: the
       * snapshot moves there, and editors based before it reload instead.
       */
      const compactionPoint = (entry: Entry, steps: KeptStep[], now: number) => {
        const all = [...entry.steps, ...steps];
        if (all.length <= COMPACT_STEPS) return 0;
        const cutoff = now - Duration.toMillis(RETAIN_STEPS);
        let count = 0;
        while (count < all.length - COMPACT_STEPS && all[count]!.createdAt < cutoff) count++;
        return count;
      };
      /** Stores steps the caller already applied to `doc`. Caller holds the row lock. */
      const store = (
        tx: DbTx,
        documentId: string,
        entry: Entry,
        doc: Node,
        steps: Step[],
        author: Author,
      ) =>
        Effect.gen(function* () {
          yield* withinTreeCap(doc);
          const now = yield* Clock.currentTimeMillis;
          const generation = author.origin === "model" ? yield* GenerationFence : null;
          const kept = steps.map((step) => ({
            json: step.toJSON() as Record<string, unknown>,
            clientId: author.clientId,
            createdAt: now,
          }));
          yield* documents.appendSteps(
            tx,
            kept.map((step, index) => ({
              documentId,
              revision: entry.revision + index + 1,
              step: step.json,
              clientId: author.clientId,
              origin: author.origin,
              userId: author.userId,
              generationId: generation?.generationId ?? null,
            })),
          );
          const revision = entry.revision + steps.length;
          const folded = compactionPoint(entry, kept, now);
          let compacted: Stored["compacted"] = null;
          if (folded) {
            const all = [...entry.steps, ...kept];
            const { doc: snapshot } = yield* applySteps(
              entry.snapshot,
              all.slice(0, folded).map((step) => step.json),
            ).pipe(Effect.orDie);
            compacted = { snapshot, revision: entry.snapshotRevision + folded };
            yield* documents.compact(
              tx,
              documentId,
              snapshot.toJSON() as Record<string, unknown>,
              compacted.revision,
            );
          }
          const document = yield* documents.write(tx, author.userId, documentId, {
            revision,
            lastEditedBy: author.origin,
            lastEditorUserId: author.userId,
          });
          return { document, doc, steps: kept, compacted } satisfies Stored;
        });
      /** Moves the entry to what was just committed and tells every editor, the sender included. */
      const settle = (entry: Entry, stored: Stored) =>
        Effect.suspend(() => {
          entry.doc = stored.doc;
          entry.steps.push(...stored.steps);
          entry.revision += stored.steps.length;
          if (stored.compacted) {
            entry.steps.splice(0, stored.compacted.revision - entry.snapshotRevision);
            entry.snapshot = stored.compacted.snapshot;
            entry.snapshotRevision = stored.compacted.revision;
          }
          return PubSub.publish(entry.frames, {
            type: "steps",
            steps: stored.steps.map((step) => step.json),
            clientIds: stored.steps.map((step) => step.clientId),
            revision: entry.revision,
          });
        });

      /**
       * Editors mint IDs for what people type; an undo bringing a block back,
       * or a client that did not, can leave one missing or repeated. The
       * server fixes that as its own step, which every editor then receives.
       */
      const repairIds = (userId: string, documentId: string, entry: Entry) =>
        Effect.gen(function* () {
          const tr = ensureIds(new Transform(entry.doc));
          if (!tr.docChanged) return;
          const stored = yield* transaction((tx) =>
            Effect.gen(function* () {
              const locked = yield* documents.lock(tx, userId, documentId);
              if (locked.revision !== entry.revision) return null;
              return yield* store(tx, documentId, entry, tr.doc, tr.steps, {
                origin: "user",
                userId,
                clientId: SERVER_CLIENT,
              });
            }),
          );
          if (stored) yield* settle(entry, stored);
        }).pipe(Effect.catchCause(() => Effect.logWarning("document ID repair failed")));

      /**
       * One model change, applied to the live document under its fence. The
       * fence goes first, so a Stop, retry or lost lease interrupts before
       * anything moves. The entry moves only after the commit.
       */
      const modelWrite = <A extends { document: EditableDocument }, E = never, R = never>(
        userId: string,
        documentId: string,
        guard: DocumentWriteGuard<E, R> | undefined,
        decide: (
          doc: Node,
          document: EditableDocument,
          /** Open threads, which a model edit may not strip of all their text. */
          open: ReadonlySet<string>,
        ) => Effect.Effect<{ result: A; tr: Transform | null }, DocumentRejected>,
        author: Author = { origin: "model", userId, clientId: MODEL_CLIENT },
      ) => {
        const attempt = exclusive(documentId)(
          Effect.gen(function* () {
            const { entry } = yield* load(userId, documentId);
            const outcome = yield* transaction((tx) =>
              Effect.gen(function* () {
                if (guard) yield* guard(tx);
                yield* requireDocuments(userId, tx);
                const locked = yield* documents.lock(tx, userId, documentId);
                if (locked.revision !== entry.revision) return yield* new StaleEntry();
                const decided = yield* decide(entry.doc, locked, openThreads(entry));
                const tr = decided.tr;
                if (!tr?.docChanged) return { result: decided.result, stored: null };
                // A table still streaming has a short last row; new cells need IDs too.
                ensureIds(squareTables(tr));
                yield* withinTreeCap(tr.doc);
                const stored = yield* store(tx, documentId, entry, tr.doc, tr.steps, author);
                return { result: { ...decided.result, document: stored.document }, stored };
              }),
            );
            if (outcome.stored) {
              yield* settle(entry, outcome.stored);
              // Only text moves here, as when a person types. A streamed edit stores
              // dozens of steps a second, and each event reloaded the chat's detail.
              yield* documentChangedSoon(userId, documentId, entry);
            }
            return outcome.result;
          }),
        );
        // A stale entry is rebuilt once; a second mismatch is a real defect.
        return attempt.pipe(
          Effect.catchTag("StaleEntry", () =>
            drop(documentId).pipe(
              Effect.andThen(attempt),
              Effect.catchTag("StaleEntry", (error) => Effect.die(error)),
            ),
          ),
        );
      };

      const openThreads = (entry: Entry) =>
        new Set(
          entry.comments
            .filter((each) => each.id === each.threadId && !each.resolvedAt)
            .map((each) => each.id),
        );

      const create = <E = never, R = never>(
        userId: string,
        input: CreateDocumentInput,
        guard?: DocumentWriteGuard<E, R>,
        from?: ImportedText,
      ) =>
        Effect.gen(function* () {
          const parsed = yield* decode(CreateDocumentInput, "invalid document")(input);
          const owner = parsed.projectId
            ? { projectId: parsed.projectId }
            : parsed.conversationId
              ? { conversationId: parsed.conversationId }
              : null;
          if (!owner || (parsed.projectId && parsed.conversationId))
            return yield* new DocumentRejected({
              reason: "a document belongs to a chat or a project",
            });
          const images = from?.images ?? [];
          const plan = yield* planImages(
            userId,
            images.length ? owner : null,
            images,
            parsed.by === "user",
          );
          // An imported tree names the document and each claimed image in their
          // addresses, so both are settled first.
          const id = uuidv7();
          const threadIds = new Map(from?.threads.map((thread) => [thread.ref, uuidv7()]));
          const doc = from
            ? yield* importedDocument(placeImported(from, id, threadIds, plan.copies))
            : yield* buildDocument(parsed.content, parsed.outline);
          // Stored as the editor will write it back, so the next read matches.
          yield* withinTreeCap(doc);
          const { document, spent } = yield* transaction((tx) =>
            Effect.gen(function* () {
              // Keep fence failures outside recoverable validation/conflict handling.
              if (guard) yield* guard(tx);
              yield* requireDocuments(userId, tx);
              if ("conversationId" in owner)
                yield* documents.lockConversation(tx, userId, owner.conversationId);
              else yield* lockProjectForEditing(tx, userId, owner.projectId);
              const created = yield* documents.create(tx, userId, owner, {
                id,
                title: parsed.title,
                // Only a chat's document dies with the answer that made it.
                createdByMessageId:
                  "conversationId" in owner ? (parsed.createdByMessageId ?? null) : null,
                lastEditedBy: parsed.by ?? "model",
                snapshot: doc.toJSON() as Record<string, unknown>,
              });
              if (!from) return { document: created, spent: [] };
              // Every picture is claimed as a person's own upload is, or nothing is stored.
              const keys = images.length
                ? yield* claimImages(tx, userId, created.id, owner, plan, images)
                : [];
              if (!keys) return yield* new DocumentRejected({ reason: IMAGE_REFUSED });
              // A file's comments are threads of their own origin; the names in it prove nothing.
              for (const thread of from.threads) {
                const threadId = threadIds.get(thread.ref)!;
                for (const [index, comment] of thread.comments.entries())
                  yield* documents.addComment(tx, {
                    id: index ? uuidv7() : threadId,
                    documentId: created.id,
                    threadId,
                    userId: null,
                    origin: "file",
                    fileAuthor: comment.author || null,
                    body: comment.text,
                    ...(index === 0 && thread.quote ? { quote: thread.quote } : {}),
                  });
                if (thread.resolved) yield* documents.resolveThread(tx, created.id, threadId, true);
              }
              return { document: created, spent: keys };
            }),
          );
          yield* files.deleteBlobs(spent);
          yield* documentChanged(userId, document);
          return { outcome: "created" as const, document, planned: plannedIds(doc) };
        });

      const apply = <E = never, R = never>(
        userId: string,
        input: {
          documentId: string;
          edit: TreeEdit;
          seen: SeenBlocks | null;
          allowDetach?: boolean | undefined;
          asPerson?: { readonly clientId: string } | undefined;
        },
        guard?: DocumentWriteGuard<E, R>,
      ) =>
        modelWrite<ApplyDocumentResult, E, R>(
          userId,
          input.documentId,
          guard,
          (doc, document, open) =>
            Effect.sync(() => {
              const applied = applyTreeEdit(doc, input.edit, input.seen);
              if ("outcome" in applied) return { result: { ...applied, document }, tr: null };
              const lost = input.allowDetach ? [] : detachedThreads(doc, applied.tr.doc, open);
              if (lost.length) return { result: { ...detachRefusal(lost), document }, tr: null };
              return {
                result: {
                  outcome: applied.tr.docChanged ? ("updated" as const) : ("unchanged" as const),
                  document,
                  touched: applied.touched,
                },
                tr: applied.tr,
              };
            }),
          input.asPerson
            ? { origin: "user", userId, clientId: input.asPerson.clientId }
            : undefined,
        );

      const rewrite = <E = never, R = never>(
        userId: string,
        input: {
          documentId: string;
          content: string;
          outline?: ReadonlyArray<string>;
          ifRevision?: number;
        },
        guard: DocumentWriteGuard<E, R>,
      ) =>
        modelWrite<{ document: EditableDocument }, E, R>(
          userId,
          input.documentId,
          guard,
          (doc, document) =>
            Effect.gen(function* () {
              if (input.ifRevision !== undefined && document.revision !== input.ifRevision)
                return yield* new DocumentRejected({ reason: EDITED_MEANWHILE });
              const next = yield* buildDocument(input.content, input.outline);
              yield* withinTreeCap(next);
              return {
                result: { document },
                tr: ensureIds(replaceDifference(new Transform(doc), next)),
              };
            }),
        ).pipe(
          Effect.map((result) => result.document),
          Effect.catchTag("DocumentNotAvailable", () => Effect.succeed(null)),
        );

      const moveToProject = <E = never, R = never>(
        userId: string,
        documentId: string,
        projectId: string,
        guard: DocumentWriteGuard<E, R>,
      ) =>
        exclusive(documentId)(
          transaction((tx) =>
            Effect.gen(function* () {
              yield* guard(tx);
              const before = yield* documents.lock(tx, userId, documentId);
              yield* lockProjectForEditing(tx, userId, projectId);
              yield* documents.moveToProject(tx, documentId, projectId);
              return { before, after: (yield* documents.get(userId, documentId, tx))! };
            }),
          ).pipe(Effect.tap(() => drop(documentId))),
        ).pipe(
          Effect.tap(({ before, after }) =>
            Effect.all([documentChanged(userId, before), documentChanged(userId, after)], {
              discard: true,
            }),
          ),
          Effect.map(({ after }) => after),
        );

      const discard = <E = never, R = never>(
        userId: string,
        documentId: string,
        guard: DocumentWriteGuard<E, R>,
        ifRevision?: number,
      ) =>
        exclusive(documentId)(
          transaction((tx) =>
            Effect.gen(function* () {
              yield* guard(tx);
              const document = yield* documents.lock(tx, userId, documentId);
              if (ifRevision !== undefined && document.revision !== ifRevision) return null;
              yield* documents.remove(tx, documentId);
              return document;
            }),
          ).pipe(Effect.tap((removed) => (removed ? drop(documentId) : Effect.void))),
        ).pipe(
          Effect.flatMap((document) =>
            document ? documentChanged(userId, document) : Effect.void,
          ),
        );

      const push = Effect.fn("DocumentService.push")(function* (
        userId: string,
        input: PushDocumentInput,
      ) {
        const parsed = yield* decode(PushDocumentInput, "invalid document update")(input);
        return yield* exclusive(parsed.documentId)(
          Effect.gen(function* () {
            yield* requireDocuments(userId);
            const { entry, document } = yield* load(userId, parsed.documentId);
            const clientId = personClient(userId, parsed.clientId);
            // Refused before the steps touch anything: a reader's cursor may move, their text may not.
            if (parsed.steps && !document.canEdit)
              return yield* new DocumentRejected({ reason: "this document is read-only for you" });
            if (parsed.presence && entry.feeds.has(clientId)) {
              // Labelled by who is signed in, never by what the client says.
              const presence = {
                ...parsed.presence,
                user: presenceUser({ id: userId, name: yield* nameOf(userId) }),
              };
              entry.presence.set(clientId, presence);
              yield* PubSub.publish(entry.frames, { type: "presence", clientId, presence });
            }
            if (!parsed.steps) return { revision: entry.revision, conflict: false };
            // Built on an older revision: the editor rebases over what its feed brings, then resends.
            if (parsed.revision !== entry.revision)
              return { revision: entry.revision, conflict: true };
            if (
              parsed.steps.reduce((total, step) => total + step.length, 0) >
              DOCUMENT_LIMITS.stepChars
            )
              return yield* new DocumentRejected({ reason: "document update is too large" });
            const json = yield* Effect.try({
              try: () => parsed.steps!.map((step) => JSON.parse(step) as Record<string, unknown>),
              catch: () => new DocumentRejected({ reason: "invalid document step" }),
            });
            const { doc, steps } = yield* applySteps(entry.doc, json, { checked: true });
            const author: Author = { origin: "user", userId, clientId };
            const stored = yield* transaction((tx) =>
              Effect.gen(function* () {
                const locked = yield* documents.lock(tx, userId, parsed.documentId);
                if (locked.revision !== entry.revision) return yield* new StaleEntry();
                return yield* store(tx, parsed.documentId, entry, doc, steps, author);
              }),
            ).pipe(
              // The editor reconnects, catches up from storage and sends again.
              Effect.catchTag("StaleEntry", () =>
                drop(parsed.documentId).pipe(
                  Effect.andThen(
                    Effect.fail(new DocumentRejected({ reason: "document changed; reload it" })),
                  ),
                ),
              ),
            );
            yield* settle(entry, stored);
            yield* repairIds(userId, parsed.documentId, entry);
            yield* documentChangedSoon(userId, parsed.documentId, entry);
            return { revision: entry.revision, conflict: false };
          }),
        );
      });

      const subscribe = Effect.fn("DocumentService.subscribe")(function* (
        userId: string,
        documentId: string,
        options: { sessionId: string; revision: number | null; clientId: string | null },
      ) {
        const canSubscribe = db
          .transaction((tx) =>
            Effect.gen(function* () {
              if (!(yield* originatingSessionEligible(tx, options.sessionId, userId))) return false;
              if (!(yield* policy.can(userId, "documents", tx))) return false;
              return Boolean(yield* documents.get(userId, documentId, tx));
            }),
          )
          .pipe(Effect.orDie);
        if (!(yield* canSubscribe)) return null;
        const gone: Stream.Stream<DocumentFrame> = Stream.make({ type: "gone" });
        return Stream.unwrap(
          exclusive(documentId)(
            Effect.gen(function* () {
              if (!(yield* canSubscribe)) return gone;
              const { entry } = yield* load(userId, documentId);
              const clientId =
                options.clientId === null ? null : personClient(userId, options.clientId);
              const seen = asSeenBy(userId);
              const ownPresence = (frame: DocumentFrame) =>
                frame.type === "presence" && frame.clientId === clientId;
              // Subscribed before the catch-up is taken, and under the lock, so
              // no step falls between the two.
              const subscription = yield* PubSub.subscribe(entry.frames);
              entry.subscribers++;
              if (clientId !== null)
                entry.feeds.set(clientId, (entry.feeds.get(clientId) ?? 0) + 1);
              yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                  entry.subscribers--;
                  entry.touched = yield* Clock.currentTimeMillis;
                  if (clientId === null) return;
                  const open = (entry.feeds.get(clientId) ?? 1) - 1;
                  if (open > 0) return void entry.feeds.set(clientId, open);
                  entry.feeds.delete(clientId);
                  if (!entry.presence.delete(clientId)) return;
                  yield* PubSub.publish(entry.frames, {
                    type: "presence",
                    clientId,
                    presence: null,
                  });
                }),
              );
              const from = options.revision;
              const catchUp: DocumentFrame =
                from !== null && from >= entry.snapshotRevision && from <= entry.revision
                  ? {
                      type: "steps",
                      steps: entry.steps.slice(from - entry.snapshotRevision).map((s) => s.json),
                      clientIds: entry.steps
                        .slice(from - entry.snapshotRevision)
                        .map((s) => s.clientId),
                      revision: entry.revision,
                    }
                  : {
                      type: "reset",
                      doc: entry.doc.toJSON() as Record<string, unknown>,
                      revision: entry.revision,
                    };
              const others: DocumentFrame[] = [...entry.presence]
                .filter(([other]) => other !== clientId)
                .map(([other, presence]) => ({ type: "presence", clientId: other, presence }));
              // Session, account, feature and resource revocation end the feed on recheck.
              // Only that ending says gone: a feed ended because the entry was
              // dropped and rebuilt is reconnected and caught up, never discarded.
              let lostAccess = false;
              const revoked = Effect.gen(function* () {
                while (true) {
                  yield* Effect.sleep(ACCESS_RECHECK);
                  if (!(yield* canSubscribe)) {
                    lostAccess = true;
                    return;
                  }
                }
              });
              return Stream.make(
                catchUp,
                { type: "comments", comments: entry.comments } satisfies DocumentFrame,
                ...others,
              ).pipe(
                Stream.concat(
                  Stream.fromSubscription(subscription).pipe(
                    Stream.filter((frame) => !ownPresence(frame)),
                    Stream.interruptWhen(revoked),
                  ),
                ),
                Stream.map(seen),
                Stream.concat(Stream.suspend(() => (lostAccess ? gone : Stream.empty))),
              );
            }),
          ).pipe(Effect.catchTag("DocumentNotAvailable", () => Effect.succeed(gone))),
        );
      });

      /**
       * One change to a document's comments, by someone who may edit it,
       * then every comment to every open editor.
       */
      const commentWrite = <E, R, GE = never, GR = never>(
        userId: string,
        documentId: string,
        write: (tx: DbTx) => Effect.Effect<void, DocumentRejected | E, R>,
        // The assistant's generation guard locks its conversation, so it runs
        // first: every other generation write takes the conversation before
        // the document, and the reverse order could deadlock with a rewind.
        guard?: DocumentWriteGuard<GE, GR>,
      ) =>
        exclusive(documentId)(
          Effect.gen(function* () {
            yield* requireDocuments(userId);
            const { entry } = yield* load(userId, documentId);
            const comments = yield* transaction((tx) =>
              Effect.gen(function* () {
                if (guard) yield* guard(tx);
                yield* documents.lock(tx, userId, documentId);
                yield* write(tx);
                return yield* documents.comments(documentId, tx);
              }),
            );
            entry.comments = comments;
            yield* PubSub.publish(entry.frames, { type: "comments", comments });
          }),
        );

      const comment = Effect.fn("DocumentService.comment")(function* (
        userId: string,
        input: CommentInput,
      ) {
        const parsed = yield* decode(CommentInput, "invalid comment")(input);
        yield* commentWrite(userId, parsed.documentId, (tx) =>
          personComment(documents, userId, parsed)(tx).pipe(Effect.asVoid),
        );
      });

      const resolveThread = Effect.fn("DocumentService.resolveThread")(function* (
        userId: string,
        input: ResolveThreadInput,
      ) {
        const parsed = yield* decode(ResolveThreadInput, "invalid thread")(input);
        yield* commentWrite(userId, parsed.documentId, threadResolution(documents, parsed));
      });

      const deleteComment = Effect.fn("DocumentService.deleteComment")(function* (
        userId: string,
        input: DeleteCommentInput,
      ) {
        const parsed = yield* decode(DeleteCommentInput, "invalid comment")(input);
        yield* commentWrite(userId, parsed.documentId, commentDeletion(documents, userId, parsed));
      });

      /**
       * The assistant on a document's comments: a reply in a thread, or a new
       * thread on text it quotes in one block, which it marks under its fence
       * like any of its writes. It never resolves: a thread is its people's.
       */
      const assistantComment = <E, R>(
        userId: string,
        input: AssistantCommentInput,
        guard: DocumentWriteGuard<E, R>,
      ) =>
        Effect.gen(function* () {
          if (input.thread) {
            const thread = input.thread;
            const { entry } = yield* exclusive(input.documentId)(load(userId, input.documentId));
            const root = entry.comments.find(
              (each) => each.id === thread && each.threadId === each.id,
            );
            if (!root)
              return {
                outcome: "not_found" as const,
                message: "No thread with that id. Its id is on <thread> in the trailing data.",
              };
            const body = input.body;
            if (!body) return { outcome: "invalid" as const, message: "A reply needs content." };
            yield* commentWrite(
              userId,
              input.documentId,
              (tx) =>
                Effect.gen(function* () {
                  // Checked again under the lock: the thread may have been deleted since.
                  const current = yield* documents.comments(input.documentId, tx);
                  if (!current.some((each) => each.id === thread))
                    return yield* new DocumentRejected({ reason: "that thread was deleted" });
                  yield* documents.addComment(tx, {
                    id: uuidv7(),
                    documentId: input.documentId,
                    threadId: thread,
                    userId: null,
                    origin: "model",
                    body,
                  });
                }),
              guard,
            );
            return { outcome: "commented" as const, thread };
          }
          if (!input.target || !input.body)
            return {
              outcome: "invalid" as const,
              message: "A new comment needs target (a block id) and content; quote narrows it.",
            };
          const thread = uuidv7();
          const marked = yield* modelWrite<
            { document: EditableDocument; refused: string | null; quote: string },
            E,
            R
          >(userId, input.documentId, guard, (doc, document) =>
            Effect.sync(() => {
              const range = quoteRange(doc, input.target!, input.quote);
              if ("refused" in range)
                return { result: { document, refused: range.refused, quote: "" }, tr: null };
              return {
                result: {
                  document,
                  refused: null,
                  quote: doc.textBetween(range.from, range.to, " ", " ").slice(0, 500),
                },
                tr: new Transform(doc).addMark(
                  range.from,
                  range.to,
                  documentSchema.marks.comment!.create({ thread }),
                ),
              };
            }),
          );
          if (marked.refused)
            return {
              outcome: (marked.refused === "ambiguous" ? "ambiguous" : "not_found") as
                | "ambiguous"
                | "not_found",
              message:
                marked.refused === "ambiguous"
                  ? "That quote occurs more than once in the block; quote more of it."
                  : marked.refused === "no_match"
                    ? "That quote is not in the block as written; copy it from the document."
                    : "No block with that id has text to comment on.",
            };
          yield* commentWrite(
            userId,
            input.documentId,
            (tx) =>
              Effect.gen(function* () {
                yield* documents.addComment(tx, {
                  id: thread,
                  documentId: input.documentId,
                  threadId: thread,
                  userId: null,
                  origin: "model",
                  body: input.body!,
                  quote: marked.quote,
                });
              }),
            guard,
          );
          return { outcome: "commented" as const, thread };
        });

      const beginLive = Effect.fn("DocumentService.beginLive")(function* (
        userId: string,
        input: {
          documentId: string;
          edit: Extract<TreeEdit, { kind: "blocks" }>;
          seen: SeenBlocks | null;
          allowDetach?: boolean | undefined;
        },
      ) {
        return yield* exclusive(input.documentId)(
          Effect.gen(function* () {
            const { entry, document } = yield* load(userId, input.documentId);
            if (!document.canEdit) return null;
            const range = resolveRange(entry.doc, input.edit.target, input.edit.through);
            if ("outcome" in range) return null;
            if (input.edit.position === "replace" && checkSeen(range, input.seen)) return null;
            const live: LiveEdit = {
              userId,
              documentId: input.documentId,
              edit: input.edit,
              seen: input.seen,
              owned: [],
              written: new Map(),
              original: null,
              broken: false,
              detached: null,
              allowDetach: input.allowDetach ?? false,
            };
            return live;
          }),
        ).pipe(Effect.catchTag("DocumentNotAvailable", () => Effect.succeed(null)));
      });

      const writeLive = <E, R>(live: LiveEdit, content: string, guard: DocumentWriteGuard<E, R>) =>
        modelWrite<{ document: EditableDocument; owned: Map<string, string> | null }, E, R>(
          live.userId,
          live.documentId,
          guard,
          (doc, document, open) =>
            Effect.sync(() => {
              const none = { result: { document, owned: null }, tr: null };
              if (live.broken) return none;
              const spot = liveSpot(doc, live);
              if (!spot) {
                live.broken = true;
                return none;
              }
              const fitted = content.trim()
                ? fitBlocks(spot.parent, spot.startIndex, spot.endIndex, content)
                : Fragment.empty;
              // Half-written Markdown that does not fit yet: wait for more.
              if (!(fitted instanceof Fragment) || (!fitted.size && !live.owned.length))
                return none;
              // Blocks keep the IDs they had in the last write, by place and
              // type, down to list items and cells: one minted afresh would
              // differ from the last tick, and the whole list be written again.
              const previous = Array.from({ length: spot.endIndex - spot.startIndex }, (_, index) =>
                spot.parent.child(spot.startIndex + index),
              );
              live.original ??= live.edit.position === "replace" ? previous : [];
              const nodes: Node[] = [];
              fitted.forEach((node, _offset, index) => {
                const before = live.owned.length ? previous[index] : undefined;
                nodes.push(
                  before && before.type === node.type ? adoptIds(before, node, false) : node,
                );
              });
              const whole = new Transform(doc).replaceWith(
                spot.from,
                spot.to,
                withFreshIds(doc, Fragment.from(nodes)),
              );
              // Squared here, not only in modelWrite: the hashes below must be
              // of what is stored, or a streaming table's short last row would
              // read on the next tick as a person's edit and end the preview.
              ensureIds(squareTables(whole));
              // Only what changed since the last tick: usually the words just streamed.
              const tr = writeDifference(new Transform(doc), whole.doc);
              const lost = live.allowDetach ? [] : detachedThreads(doc, tr.doc, open);
              if (lost.length) {
                live.broken = true;
                live.detached = lost;
                return none;
              }
              // Sized from the result: squaring may have added cells to what was built.
              const end = spot.to + tr.doc.content.size - doc.content.size;
              // Taken on only once stored: a write that fails to commit, or is
              // decided again on a retry, must not leave the preview owning
              // blocks that never existed.
              const owned = new Map<string, string>();
              tr.doc.slice(spot.from, end).content.forEach((node) => {
                owned.set(blockIdOf(node)!, blockHash(node));
              });
              return { result: { document, owned }, tr };
            }),
        ).pipe(
          Effect.tap(({ owned }) =>
            Effect.sync(() => {
              if (!owned) return;
              live.owned = [...owned.keys()];
              live.written = owned;
            }),
          ),
        );

      const updateLive = <E, R>(live: LiveEdit, content: string, guard: DocumentWriteGuard<E, R>) =>
        writeLive(live, content, guard).pipe(Effect.map(() => !live.broken));

      const settleLive = <E, R>(live: LiveEdit, content: string, guard: DocumentWriteGuard<E, R>) =>
        writeLive(live, content, guard).pipe(
          Effect.map(({ document }): ApplyDocumentResult =>
            live.detached
              ? { ...detachRefusal(live.detached), document }
              : live.broken
                ? {
                    outcome: "conflict",
                    document,
                    message:
                      "Someone edited those blocks while you were writing them. Their change stays; read the current content and aim again.",
                  }
                : { outcome: "updated", document, touched: [...live.owned] },
          ),
        );

      const revertLive = <E, R>(live: LiveEdit, guard: DocumentWriteGuard<E, R>) =>
        modelWrite<{ document: EditableDocument }, E, R>(
          live.userId,
          live.documentId,
          guard,
          (doc, document) =>
            Effect.sync(() => {
              const none = { result: { document }, tr: null };
              if (live.broken || !live.owned.length || !live.original) return none;
              const spot = ownedRange(doc, live);
              if (!spot) return none;
              live.broken = true;
              return {
                result: { document },
                tr: new Transform(doc).replaceWith(spot.from, spot.to, live.original),
              };
            }),
        ).pipe(Effect.asVoid);

      // Idle entries leave memory; one still watched stays however old it is.
      yield* Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        for (const [documentId, entry] of entries)
          if (entry.subscribers === 0 && now - entry.touched > Duration.toMillis(IDLE))
            yield* exclusive(documentId)(
              Effect.suspend(() =>
                entries.get(documentId) === entry && entry.subscribers === 0
                  ? drop(documentId)
                  : Effect.void,
              ),
            );
      }).pipe(Effect.repeat(Schedule.spaced(IDLE)), Effect.forkScoped);

      return DocumentService.of({
        get: Effect.fn(function* (userId, documentId) {
          return (yield* policy.can(userId, "documents"))
            ? yield* documents.get(userId, documentId)
            : null;
        }),
        list: Effect.fn(function* (userId, owner) {
          return (yield* policy.can(userId, "documents"))
            ? yield* documents.list(userId, owner)
            : [];
        }),
        remove: Effect.fn("DocumentService.remove")(function* (userId, documentId) {
          const removed = yield* exclusive(documentId)(
            transaction((tx) =>
              Effect.gen(function* () {
                yield* requireDocuments(userId, tx);
                const document = yield* documents.lock(tx, userId, documentId);
                if (!document.projectId)
                  return yield* new DocumentRejected({
                    reason: "a chat's document goes with the answer that made it",
                  });
                yield* documents.remove(tx, documentId);
                return document;
              }),
            ).pipe(Effect.tap(() => drop(documentId))),
          );
          yield* documentChanged(userId, removed);
        }),
        rename: Effect.fn("DocumentService.rename")(function* (userId, documentId, title) {
          const renamed = yield* exclusive(documentId)(
            transaction((tx) =>
              Effect.gen(function* () {
                yield* requireDocuments(userId, tx);
                yield* documents.lock(tx, userId, documentId);
                return yield* documents.write(tx, userId, documentId, { title });
              }),
            ),
          );
          yield* documentChanged(userId, renamed);
          return renamed;
        }),
        addImage: Effect.fn("DocumentService.addImage")(function* (userId, input) {
          const found = yield* documents.get(userId, input.documentId);
          const plan = yield* planImages(
            userId,
            found ? ownerOf(found) : null,
            [input.attachmentId],
            true,
          );
          const spent = yield* transaction((tx) =>
            Effect.gen(function* () {
              yield* requireDocuments(userId, tx);
              // The row lock holds off a delete until the claim commits.
              const document = yield* documents.lock(tx, userId, input.documentId);
              return yield* claimImages(tx, userId, document.id, ownerOf(document), plan, [
                input.attachmentId,
              ]);
            }),
          );
          if (!spent) return yield* new DocumentRejected({ reason: IMAGE_REFUSED });
          yield* files.deleteBlobs(spent);
          const claimed = plan.copies.get(input.attachmentId) ?? input.attachmentId;
          return documentImagePath(input.documentId, claimed);
        }),
        create,
        versions: Effect.fn("DocumentService.versions")(function* (userId, documentId) {
          if (!(yield* policy.can(userId, "documents"))) return null;
          const loaded = yield* exclusive(documentId)(load(userId, documentId)).pipe(
            Effect.catchTag("DocumentNotAvailable", () => Effect.succeed(null)),
          );
          if (!loaded?.document.canEdit) return null;
          const { entry } = loaded;
          const authors = yield* documents.stepAuthors(documentId, entry.snapshotRevision);
          const oldest = entry.steps[0]?.createdAt ?? Date.now();
          return groupVersions(authors, {
            revision: entry.snapshotRevision,
            at: new Date(oldest),
          });
        }),
        versionAt: Effect.fn("DocumentService.versionAt")(function* (userId, documentId, revision) {
          if (!(yield* policy.can(userId, "documents"))) return null;
          return yield* exclusive(documentId)(
            Effect.gen(function* () {
              const { entry, document } = yield* load(userId, documentId);
              if (!document.canEdit) return null;
              const count = revision - entry.snapshotRevision;
              if (!Number.isInteger(count) || count < 0 || count > entry.steps.length) return null;
              const { doc } = yield* applySteps(
                entry.snapshot,
                entry.steps.slice(0, count).map((step) => step.json),
              ).pipe(Effect.orDie);
              return JSON.stringify(doc.toJSON());
            }),
          ).pipe(Effect.catchTag("DocumentNotAvailable", () => Effect.succeed(null)));
        }),
        read: Effect.fn("DocumentService.read")(function* (userId, documentId) {
          if (!(yield* policy.can(userId, "documents"))) return null;
          return yield* exclusive(documentId)(
            load(userId, documentId).pipe(
              Effect.map(({ entry, document }) => ({
                document,
                doc: entry.doc,
                comments: entry.comments,
              })),
            ),
          ).pipe(Effect.catchTag("DocumentNotAvailable", () => Effect.succeed(null)));
        }),
        apply,
        rewrite,
        discard,
        moveToProject,
        push,
        subscribe,
        beginLive,
        updateLive,
        settleLive,
        revertLive,
        comment,
        resolveThread,
        deleteComment,
        assistantComment,
      });
    }),
  ).pipe(Layer.provide(DocumentRepo.layer));
}
