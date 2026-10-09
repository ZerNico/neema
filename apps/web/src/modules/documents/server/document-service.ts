import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  PubSub,
  Schedule,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { Fragment, Node } from "@tiptap/pm/model";
import { Step, Transform } from "@tiptap/pm/transform";
import { eq } from "drizzle-orm";
import { projects } from "~/db/schema/index.ts";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import { GenerationFence } from "~/modules/chat/server/generation-fence.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { projectCan } from "~/modules/projects/schema.ts";
import { projectAudience, projectRole } from "~/modules/projects/server/access.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import {
  BLOCK_ID,
  blockIdOf,
  ensureIds,
  findBlocks,
  isBlock,
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
import {
  documentSchema,
  parseMarkdown,
  replaceDifference,
  toMarkdown,
} from "../editor/markdown.ts";
import {
  CreateDocumentInput,
  DOCUMENT_LIMITS,
  DocumentNotAvailable,
  DocumentRejected,
  PushDocumentInput,
  type ApplyDocumentResult,
  type DocumentFrame,
  type DocumentPresence,
  type EditableDocument,
  type PushDocumentResult,
} from "../schema.ts";
import { DocumentRepo, type DocumentOwner } from "./document-repo.ts";

export type DocumentWriteGuard<E = never, R = never> = (tx: DbTx) => Effect.Effect<unknown, E, R>;
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
const withinCap = (length: number) =>
  length > DOCUMENT_LIMITS.chars
    ? Effect.fail(
        new DocumentRejected({ reason: `document exceeds ${DOCUMENT_LIMITS.chars} characters` }),
      )
    : Effect.void;
/** Steps rebuilt from JSON and applied in order; any that does not fit the schema refuses all. */
const applySteps = (doc: Node, json: ReadonlyArray<Record<string, unknown>>) =>
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
}
/** The stored revision moved without this process: rebuild the entry from storage. */
class StaleEntry extends Schema.TaggedError<StaleEntry>()("StaleEntry", {}) {}

/** Holds the project row against deletion while a document is added to it. */
const lockProjectForEditing = (tx: DbTx, userId: string, projectId: string) =>
  Effect.gen(function* () {
    const [row] = yield* tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for("share")
      .pipe(Effect.orDie);
    const role = row ? yield* projectRole(tx, userId, projectId) : null;
    if (!role) return yield* new DocumentNotAvailable({ documentId: projectId });
    if (!projectCan.edit(role))
      return yield* new DocumentRejected({ reason: "this project is read-only for you" });
  });
/** The tree-size limits Markdown length cannot see: planned sections write none. */
const withinTreeCap = (doc: Node) => {
  let blocks = 0;
  let intents = 0;
  doc.descendants((node) => {
    if (isBlock(node)) blocks++;
    if (node.type.name === "pending") intents += String(node.attrs.intent ?? "").length;
    return true;
  });
  if (blocks > DOCUMENT_LIMITS.blocks)
    return Effect.fail(
      new DocumentRejected({ reason: `document exceeds ${DOCUMENT_LIMITS.blocks} blocks` }),
    );
  return withinCap(intents);
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
const buildDocument = (content: string, outline: ReadonlyArray<string> = []) => {
  const parsed = parseMarkdown(content);
  const pending = outline.map((intent) =>
    documentSchema.nodes.pending!.create({ intent: intent.slice(0, PENDING_INTENT_CHARS) }),
  );
  // An empty document still holds one empty paragraph to type into.
  const doc = documentSchema.nodes.doc!.createAndFill(null, [
    ...Array.from({ length: parsed.childCount }, (_, index) => parsed.child(index)),
    ...pending,
  ])!;
  return ensureIds(new Transform(doc)).doc;
};
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
    create<E = never, R = never>(
      userId: string,
      input: CreateDocumentInput,
      guard?: DocumentWriteGuard<E, R>,
    ): Effect.Effect<
      { outcome: "created"; document: EditableDocument; planned: string[] },
      DocumentError | E,
      R
    >;
    /** The live tree, for rendering what the model reads. Null when not this person's. */
    read(
      userId: string,
      documentId: string,
    ): Effect.Effect<{ document: EditableDocument; doc: Node } | null>;
    /**
     * One model edit aimed at blocks by ID or at text in one block. A replace
     * or delete must cover only blocks `seen` holds as they are now, so a
     * person's typing since the model read is never written over.
     */
    apply<E = never, R = never>(
      userId: string,
      input: { documentId: string; edit: TreeEdit; seen: SeenBlocks | null },
      guard?: DocumentWriteGuard<E, R>,
    ): Effect.Effect<ApplyDocumentResult, DocumentError | E, R>;
    /**
     * Makes the whole document read as `markdown` and `outline`, as the
     * smallest change: what a streamed `create_document` writes into the
     * document it created.
     */
    rewrite<E = never, R = never>(
      userId: string,
      input: { documentId: string; content: string; outline?: ReadonlyArray<string> },
      guard: DocumentWriteGuard<E, R>,
    ): Effect.Effect<EditableDocument | null, DocumentError | E, R>;
    /** Deletes a chat document an unclaimed streamed creation left behind. */
    discard<E = never, R = never>(
      userId: string,
      documentId: string,
      guard: DocumentWriteGuard<E, R>,
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
      options: { revision: number | null; clientId: string | null },
    ): Effect.Effect<Stream.Stream<DocumentFrame> | null>;
  }
>()("chat/documents/DocumentService") {
  static readonly layer = Layer.effect(
    DocumentService,
    Effect.gen(function* () {
      const db = yield* Db;
      const policy = yield* FeaturePolicy;
      const documents = yield* DocumentRepo;
      const bus = yield* SyncBus;
      const scope = yield* Effect.scope;
      // One process owns every document's live state (see docs/internals/documents.md).
      const entries = new Map<string, Entry>();
      const locks = new Map<string, { semaphore: Semaphore.Semaphore; holders: number }>();

      /** Every read-modify-write of one document runs alone, so memory and rows move together. */
      const exclusive =
        (documentId: string) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              const lock = locks.get(documentId) ?? {
                semaphore: Semaphore.makeUnsafe(1),
                holders: 0,
              };
              lock.holders++;
              locks.set(documentId, lock);
              return lock;
            }),
            (lock) => lock.semaphore.withPermits(1)(effect),
            (lock) =>
              Effect.sync(() => {
                if (--lock.holders === 0) locks.delete(documentId);
              }),
          );
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

      /** A chat's document concerns its owner; a project's, every member. */
      const documentChanged = (
        userId: string,
        document: Pick<EditableDocument, "id" | "conversationId" | "projectId">,
      ) =>
        Effect.gen(function* () {
          const audience = document.projectId
            ? yield* projectAudience(db, document.projectId)
            : [userId];
          yield* Effect.forEach(
            audience,
            (memberId) =>
              bus.publish(memberId, {
                type: "document.changed",
                ...(document.conversationId
                  ? { conversationId: document.conversationId }
                  : { projectId: document.projectId! }),
                documentId: document.id,
              }),
            { discard: true },
          );
        }).pipe(Effect.catchCause(() => Effect.logWarning("document invalidation failed")));
      /** A person's keystrokes would otherwise send one notification per batch. */
      const documentChangedSoon = (userId: string, documentId: string, entry: Entry) =>
        Effect.suspend(() => {
          if (entry.changedPending) return Effect.void;
          entry.changedPending = true;
          return Effect.sleep(CHANGED_THROTTLE).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                entry.changedPending = false;
                return documentChanged(userId, {
                  id: documentId,
                  conversationId: entry.conversationId,
                  projectId: entry.projectId,
                });
              }),
            ),
            Effect.forkIn(scope),
            Effect.asVoid,
          );
        });

      const transaction = <A, E, R>(body: (tx: DbTx) => Effect.Effect<A, E, R>) =>
        db.transaction(body).pipe(Effect.catchTag("SqlError", Effect.die));

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
          const content = toMarkdown(doc);
          yield* withinCap(content.length);
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
            content,
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
        ) => Effect.Effect<{ result: A; tr: Transform | null }, DocumentRejected>,
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
                const decided = yield* decide(entry.doc, locked);
                const tr = decided.tr;
                if (!tr?.docChanged) return { result: decided.result, stored: null };
                yield* withinTreeCap(tr.doc);
                const stored = yield* store(tx, documentId, entry, tr.doc, tr.steps, {
                  origin: "model",
                  userId,
                  clientId: MODEL_CLIENT,
                });
                return { result: { ...decided.result, document: stored.document }, stored };
              }),
            );
            if (outcome.stored) {
              yield* settle(entry, outcome.stored);
              yield* documentChanged(userId, outcome.stored.document);
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

      const create = <E = never, R = never>(
        userId: string,
        input: CreateDocumentInput,
        guard?: DocumentWriteGuard<E, R>,
      ) =>
        Effect.gen(function* () {
          const parsed = yield* decode(CreateDocumentInput, "invalid document")(input);
          const doc = buildDocument(parsed.content, parsed.outline);
          // Stored as the editor will write it back, so the next read matches.
          const content = toMarkdown(doc);
          yield* withinCap(content.length);
          yield* withinTreeCap(doc);
          const owner = parsed.projectId
            ? { projectId: parsed.projectId }
            : parsed.conversationId
              ? { conversationId: parsed.conversationId }
              : null;
          if (!owner || (parsed.projectId && parsed.conversationId))
            return yield* new DocumentRejected({
              reason: "a document belongs to a chat or a project",
            });
          const document = yield* transaction((tx) =>
            Effect.gen(function* () {
              // Keep fence failures outside recoverable validation/conflict handling.
              if (guard) yield* guard(tx);
              yield* requireDocuments(userId, tx);
              if ("conversationId" in owner)
                yield* documents.lockConversation(tx, userId, owner.conversationId);
              else yield* lockProjectForEditing(tx, userId, owner.projectId);
              return yield* documents.create(tx, userId, owner, {
                title: parsed.title,
                content,
                // Only a chat's document dies with the answer that made it.
                createdByMessageId:
                  "conversationId" in owner ? (parsed.createdByMessageId ?? null) : null,
                lastEditedBy: parsed.by ?? "model",
                snapshot: doc.toJSON() as Record<string, unknown>,
              });
            }),
          );
          yield* documentChanged(userId, document);
          return { outcome: "created" as const, document, planned: plannedIds(doc) };
        });

      const apply = <E = never, R = never>(
        userId: string,
        input: { documentId: string; edit: TreeEdit; seen: SeenBlocks | null },
        guard?: DocumentWriteGuard<E, R>,
      ) =>
        modelWrite<ApplyDocumentResult, E, R>(userId, input.documentId, guard, (doc, document) =>
          Effect.sync(() => {
            const applied = applyTreeEdit(doc, input.edit, input.seen);
            if ("outcome" in applied) return { result: { ...applied, document }, tr: null };
            return {
              result: {
                outcome: applied.tr.docChanged ? ("updated" as const) : ("unchanged" as const),
                document,
                touched: applied.touched,
              },
              tr: applied.tr,
            };
          }),
        );

      const rewrite = <E = never, R = never>(
        userId: string,
        input: { documentId: string; content: string; outline?: ReadonlyArray<string> },
        guard: DocumentWriteGuard<E, R>,
      ) =>
        modelWrite<{ document: EditableDocument }, E, R>(
          userId,
          input.documentId,
          guard,
          (doc, document) =>
            Effect.gen(function* () {
              const next = buildDocument(input.content, input.outline);
              yield* withinCap(toMarkdown(next).length);
              return {
                result: { document },
                tr: ensureIds(replaceDifference(new Transform(doc), next)),
              };
            }),
        ).pipe(
          Effect.map((result) => result.document),
          Effect.catchTag("DocumentNotAvailable", () => Effect.succeed(null)),
        );

      const discard = <E = never, R = never>(
        userId: string,
        documentId: string,
        guard: DocumentWriteGuard<E, R>,
      ) =>
        exclusive(documentId)(
          transaction((tx) =>
            Effect.gen(function* () {
              yield* guard(tx);
              const document = yield* documents.lock(tx, userId, documentId);
              yield* documents.remove(tx, documentId);
              return document;
            }),
          ).pipe(Effect.tap(() => drop(documentId))),
        ).pipe(Effect.flatMap((document) => documentChanged(userId, document)));

      const push = Effect.fn("DocumentService.push")(function* (
        userId: string,
        input: PushDocumentInput,
      ) {
        const parsed = yield* decode(PushDocumentInput, "invalid document update")(input);
        return yield* exclusive(parsed.documentId)(
          Effect.gen(function* () {
            yield* requireDocuments(userId);
            const { entry, document } = yield* load(userId, parsed.documentId);
            // Refused before the steps touch anything: a reader's cursor may move, their text may not.
            if (parsed.steps && !document.canEdit)
              return yield* new DocumentRejected({ reason: "this document is read-only for you" });
            if (parsed.presence) {
              entry.presence.set(parsed.clientId, parsed.presence);
              yield* PubSub.publish(entry.frames, {
                type: "presence",
                clientId: parsed.clientId,
                presence: parsed.presence,
              });
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
            const { doc, steps } = yield* applySteps(entry.doc, json);
            const author: Author = { origin: "user", userId, clientId: parsed.clientId };
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
        options: { revision: number | null; clientId: string | null },
      ) {
        if (!(yield* policy.can(userId, "documents"))) return null;
        if (!(yield* documents.get(userId, documentId))) return null;
        const gone: Stream.Stream<DocumentFrame> = Stream.make({ type: "gone" });
        const ownPresence = (frame: DocumentFrame) =>
          frame.type === "presence" && frame.clientId === options.clientId;
        return Stream.unwrap(
          exclusive(documentId)(
            Effect.gen(function* () {
              const { entry } = yield* load(userId, documentId);
              // Subscribed before the catch-up is taken, and under the lock, so
              // no step falls between the two.
              const subscription = yield* PubSub.subscribe(entry.frames);
              entry.subscribers++;
              yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                  entry.subscribers--;
                  entry.touched = yield* Clock.currentTimeMillis;
                  if (options.clientId === null || !entry.presence.delete(options.clientId)) return;
                  yield* PubSub.publish(entry.frames, {
                    type: "presence",
                    clientId: options.clientId,
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
                .filter(([clientId]) => clientId !== options.clientId)
                .map(([clientId, presence]) => ({ type: "presence", clientId, presence }));
              // Someone removed from the project stops receiving within one check.
              const revoked = Effect.gen(function* () {
                while (true) {
                  yield* Effect.sleep(ACCESS_RECHECK);
                  if (!(yield* documents.get(userId, documentId))) return;
                }
              });
              return Stream.make(catchUp, ...others).pipe(
                Stream.concat(
                  Stream.fromSubscription(subscription).pipe(
                    Stream.filter((frame) => !ownPresence(frame)),
                    Stream.interruptWhen(revoked),
                  ),
                ),
                Stream.concat(
                  Stream.suspend(() => (entries.has(documentId) ? gone : Stream.empty)),
                ),
              );
            }),
          ).pipe(Effect.catchTag("DocumentNotAvailable", () => Effect.succeed(gone))),
        );
      });

      const beginLive = Effect.fn("DocumentService.beginLive")(function* (
        userId: string,
        input: {
          documentId: string;
          edit: Extract<TreeEdit, { kind: "blocks" }>;
          seen: SeenBlocks | null;
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
            };
            return live;
          }),
        ).pipe(Effect.catchTag("DocumentNotAvailable", () => Effect.succeed(null)));
      });

      const writeLive = <E, R>(live: LiveEdit, content: string, guard: DocumentWriteGuard<E, R>) =>
        modelWrite<{ document: EditableDocument; written: boolean }, E, R>(
          live.userId,
          live.documentId,
          guard,
          (doc, document) =>
            Effect.sync(() => {
              const none = { result: { document, written: false }, tr: null };
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
              // Blocks keep the IDs they had in the last write, by place and type.
              const previous = Array.from({ length: spot.endIndex - spot.startIndex }, (_, index) =>
                spot.parent.child(spot.startIndex + index),
              );
              live.original ??= live.edit.position === "replace" ? previous : [];
              const nodes: Node[] = [];
              fitted.forEach((node, _offset, index) => {
                const before = live.owned.length ? previous[index] : undefined;
                nodes.push(
                  before && before.type === node.type
                    ? node.type.create(
                        { ...node.attrs, [BLOCK_ID]: blockIdOf(before) },
                        node.content,
                        node.marks,
                      )
                    : node,
                );
              });
              const tr = new Transform(doc).replaceWith(
                spot.from,
                spot.to,
                withFreshIds(doc, Fragment.from(nodes)),
              );
              ensureIds(tr);
              const written = tr.doc.slice(
                spot.from,
                spot.from + Fragment.from(nodes).size,
              ).content;
              live.owned = [];
              live.written = new Map();
              written.forEach((node) => {
                const id = blockIdOf(node)!;
                live.owned.push(id);
                live.written.set(id, blockHash(node));
              });
              return { result: { document, written: true }, tr };
            }),
        );

      const updateLive = <E, R>(live: LiveEdit, content: string, guard: DocumentWriteGuard<E, R>) =>
        writeLive(live, content, guard).pipe(Effect.map(() => !live.broken));

      const settleLive = <E, R>(live: LiveEdit, content: string, guard: DocumentWriteGuard<E, R>) =>
        writeLive(live, content, guard).pipe(
          Effect.map(({ document }): ApplyDocumentResult =>
            live.broken
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
        create,
        read: Effect.fn("DocumentService.read")(function* (userId, documentId) {
          if (!(yield* policy.can(userId, "documents"))) return null;
          return yield* exclusive(documentId)(
            load(userId, documentId).pipe(
              Effect.map(({ entry, document }) => ({ document, doc: entry.doc })),
            ),
          ).pipe(Effect.catchTag("DocumentNotAvailable", () => Effect.succeed(null)));
        }),
        apply,
        rewrite,
        discard,
        push,
        subscribe,
        beginLive,
        updateLive,
        settleLive,
        revertLive,
      });
    }),
  ).pipe(Layer.provide(DocumentRepo.layer));
}
