import { Clock, Context, Duration, Effect, Layer, PubSub, Schedule, Schema, Stream } from "effect";
import { and, eq, sql } from "drizzle-orm";
import { SHEET_LOCALES } from "@chat/sheet/locales";
import { applyChange } from "@chat/sheet/model/apply";
import { LIVE_LIMITS, overLimits } from "@chat/sheet/model/limits";
import { emptyDoc, positions, type SheetDoc } from "@chat/sheet/model";
import { parseChange, type SheetChange, type SheetOp } from "@chat/sheet/model/ops";
import { sheetClients } from "~/db/schema/index.ts";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { presenceUser } from "../../presence-user.ts";
import { uuidv7 } from "uuidv7";
import {
  CommentInput,
  DeleteCommentInput,
  DocumentNotAvailable,
  DocumentRejected,
  ResolveThreadInput,
  type DocumentComment,
  type EditableDocument,
} from "../../schema.ts";
import { DocumentRepo, type StoredStep } from "../../server/document-repo.ts";
import type { DocumentWriteGuard } from "../../server/document-service.ts";
import {
  commentDeletion,
  documentLocks,
  lockProjectForEditing,
  notifyDocumentChanged,
  personComment,
  threadResolution,
} from "../../server/live-shared.ts";
import {
  CreateSheetInput,
  PushSheetInput,
  type PushSheetResult,
  type SheetFrame,
  type SheetMoment,
  type SheetPresence,
} from "../schema.ts";
import { momentAt, validTimeZone } from "./moment.ts";

type DocumentError = DocumentNotAvailable | DocumentRejected;

/**
 * Changes are folded into the snapshot once more than `COMPACT_STEPS` are
 * kept and they are older than `RETAIN_STEPS`, or sooner when the kept log
 * outgrows `LOG_BYTES`. An editor based before the snapshot gets a reset and
 * replays what it has not had acknowledged.
 */
const COMPACT_STEPS = 2_000;
const RETAIN_STEPS = Duration.days(30);
const LOG_BYTES = 32_000_000;
const IDLE = Duration.minutes(1);
const ACCESS_RECHECK = Duration.seconds(30);
const CHANGED_THROTTLE = Duration.seconds(1);

interface Kept {
  readonly change: SheetChange;
  readonly createdAt: number;
  readonly bytes: number;
}
interface Entry {
  /** The document at `revision`; moves only once a write has committed. */
  doc: SheetDoc;
  snapshot: SheetDoc;
  snapshotRevision: number;
  steps: Kept[];
  revision: number;
  /** When `revision` committed: what NOW reads. */
  committedAt: number;
  /** Each client's last sequence number, as far as this entry has read or written it. */
  readonly acked: Map<string, number>;
  readonly presence: Map<string, SheetPresence>;
  comments: DocumentComment[];
  readonly frames: PubSub.PubSub<SheetFrame>;
  readonly conversationId: string | null;
  readonly projectId: string | null;
  subscribers: number;
  touched: number;
  changedPending: boolean;
}
interface Author {
  origin: "user" | "model";
  userId: string;
  generationId: string | null;
}
/** What one committed write did, for `settle` to bring the entry along. */
interface Stored {
  document: EditableDocument;
  doc: SheetDoc;
  kept: Kept[];
  committedAt: number;
  compacted: { snapshot: SheetDoc; revision: number } | null;
  acked: { clientId: string; seq: number } | null;
  refused: Array<{ seq: number; reason: string }>;
  dropped: string[];
}

/** The stored row is the server's own JSON, checked when it arrived. */
const storedDoc = (json: unknown) => json as SheetDoc;
const storedChange = (step: StoredStep) => {
  const parsed = parseChange(step.step);
  // A stored change that no longer reads means storage is corrupt, which is a defect.
  if (!parsed.ok) throw new Error(`stored sheet change ${step.revision}: ${parsed.error}`);
  return parsed.change;
};
const sizeOf = (change: SheetChange) => JSON.stringify(change).length;

/** Why a change cannot be applied at all, before it touches the document. */
const refusal = (change: SheetChange) => {
  if (sizeOf(change) > LIVE_LIMITS.changeBytes) return "a change too large to send at once";
  for (const op of change.ops)
    if (op.op === "settings") {
      if (op.locale !== undefined && !SHEET_LOCALES.some((locale) => locale.id === op.locale))
        return `no locale ${op.locale}`;
      if (op.timeZone !== undefined && !validTimeZone(op.timeZone))
        return `no time zone ${op.timeZone}`;
    }
  return null;
};

/**
 * Applies changes in order from `revision`. Limits are measured once for the
 * batch; only when it ends over them is each change measured, so one change
 * that would cross them is refused and the rest apply.
 */
function foldChanges(doc: SheetDoc, revision: number, changes: ReadonlyArray<SheetChange>) {
  const run = (measureEach: boolean) => {
    let next = doc;
    const applied: SheetChange[] = [];
    const refused: Array<{ seq: number; reason: string }> = [];
    const dropped: string[] = [];
    for (const change of changes) {
      const why = refusal(change);
      if (why) {
        refused.push({ seq: change.seq, reason: why });
        continue;
      }
      const result = applyChange(next, change, revision + applied.length + 1);
      const over = measureEach ? overLimits(result.doc) : null;
      if (over) {
        refused.push({ seq: change.seq, reason: `it would make ${over}` });
        continue;
      }
      next = result.doc;
      applied.push(change);
      dropped.push(...result.dropped);
    }
    return { doc: next, applied, refused, dropped };
  };
  const batch = run(false);
  return batch.applied.length && overLimits(batch.doc) ? run(true) : batch;
}

/** The snapshot and steps rebuilt into the document at the latest revision. */
const replay = (snapshot: SheetDoc, from: number, changes: ReadonlyArray<SheetChange>) =>
  changes.reduce((doc, change, index) => applyChange(doc, change, from + index + 1).doc, snapshot);

/** How many of the kept changes to fold into the snapshot now. */
const compactionPoint = (all: ReadonlyArray<Kept>, now: number) => {
  const cutoff = now - Duration.toMillis(RETAIN_STEPS);
  let bytes = all.reduce((total, kept) => total + kept.bytes, 0);
  let count = 0;
  while (
    count < all.length &&
    (bytes > LOG_BYTES || (all.length - count > COMPACT_STEPS && all[count]!.createdAt < cutoff))
  ) {
    bytes -= all[count]!.bytes;
    count++;
  }
  return count;
};

/** A cell a thread can sit on: on a live sheet, in a live row and column. */
const cellExists = (doc: SheetDoc, cell: { sh: string; r: string; c: string }) => {
  const sheet = doc.sheet[cell.sh];
  return (
    !!sheet &&
    doc.sheets.some((entry) => entry.id === cell.sh && !entry.dead) &&
    positions(sheet.rows).at(cell.r) !== undefined &&
    positions(sheet.cols).at(cell.c) !== undefined
  );
};
/** The client a person's comment anchors are written as. */
const personClient = (userId: string) => `p.${userId}`.slice(0, 64);

/** The stored revision moved without this process: rebuild the entry from storage. */
class StaleEntry extends Schema.TaggedError<StaleEntry>()("StaleEntry", {}) {}

const decode =
  <S extends Schema.Top>(schema: S, reason: string) =>
  (input: S["Type"]) =>
    Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => new DocumentRejected({ reason })),
    );

export class SheetService extends Context.Service<
  SheetService,
  {
    create<E = never, R = never>(
      userId: string,
      input: CreateSheetInput,
      guard?: DocumentWriteGuard<E, R>,
    ): Effect.Effect<EditableDocument, DocumentError | E, R>;
    /** The live document and what its volatile functions read. Null when not this person's. */
    read(
      userId: string,
      documentId: string,
    ): Effect.Effect<{
      document: EditableDocument;
      doc: SheetDoc;
      revision: number;
      moment: SheetMoment;
      comments: ReadonlyArray<DocumentComment>;
    } | null>;
    /**
     * One server-made change, such as the model's, decided on the current
     * document under the write's guard. It takes the next sequence number of
     * `clientId`. A null `ops` writes nothing.
     */
    change<A, E = never, R = never>(
      userId: string,
      input: { documentId: string; clientId: string; generationId: string | null },
      guard: DocumentWriteGuard<E, R> | undefined,
      decide: (
        doc: SheetDoc,
        document: EditableDocument,
      ) => Effect.Effect<{ result: A; ops: ReadonlyArray<SheetOp> | null }, DocumentRejected>,
    ): Effect.Effect<
      { result: A; document: EditableDocument; refused: string | null; dropped: string[] },
      DocumentError | E,
      R
    >;
    /** A person's sheet editor: changes in its sequence and/or its cursor. */
    push(userId: string, input: PushSheetInput): Effect.Effect<PushSheetResult, DocumentError>;
    /** A person's comment: a reply, or a new thread on the cell it names. */
    comment(userId: string, input: CommentInput): Effect.Effect<void, DocumentError>;
    resolveThread(userId: string, input: ResolveThreadInput): Effect.Effect<void, DocumentError>;
    deleteComment(userId: string, input: DeleteCommentInput): Effect.Effect<void, DocumentError>;
    /** The assistant replying in a thread, or starting one on a cell, under its fence. */
    assistantComment<E, R>(
      userId: string,
      input: {
        documentId: string;
        thread?: string | undefined;
        cell?: { sh: string; r: string; c: string } | undefined;
        quote?: string | undefined;
        body: string;
      },
      guard: DocumentWriteGuard<E, R>,
    ): Effect.Effect<
      | { outcome: "commented"; thread: string }
      | { outcome: "not_found" | "invalid"; message: string },
      DocumentError | E,
      R
    >;
    /**
     * The live feed for one open sheet: the changes since `revision` (or the
     * whole document when that is too old or absent), then every later change
     * and cursor. Null when the document is not the person's.
     */
    subscribe(
      userId: string,
      documentId: string,
      options: { revision: number | null; clientId: string | null },
    ): Effect.Effect<Stream.Stream<SheetFrame> | null>;
  }
>()("chat/documents/SheetService") {
  static readonly layer = Layer.effect(
    SheetService,
    Effect.gen(function* () {
      const db = yield* Db;
      const policy = yield* FeaturePolicy;
      const documents = yield* DocumentRepo;
      const bus = yield* SyncBus;
      const scope = yield* Effect.scope;
      // One process owns every document's live state (see docs/internals/documents.md).
      const entries = new Map<string, Entry>();
      const exclusive = documentLocks();
      const documentChanged = notifyDocumentChanged(db, bus);
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
          return PubSub.shutdown(entry.frames);
        });
      yield* Effect.addFinalizer(() =>
        Effect.forEach([...entries.keys()], drop, { discard: true }),
      );
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
      const momentOf = (documentId: string, entry: Entry) =>
        momentAt(documentId, entry.revision, entry.committedAt, entry.doc.settings.timeZone);

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
          if (!state || state.document.kind !== "sheet")
            return yield* new DocumentNotAvailable({ documentId });
          const snapshot = storedDoc(state.snapshot);
          const changes = yield* Effect.sync(() => state.steps.map(storedChange));
          const last = state.steps.at(-1);
          const entry: Entry = {
            doc: replay(snapshot, state.snapshotRevision, changes),
            snapshot,
            snapshotRevision: state.snapshotRevision,
            steps: state.steps.map((row, index) => ({
              change: changes[index]!,
              createdAt: row.createdAt.getTime(),
              bytes: sizeOf(changes[index]!),
            })),
            revision: state.document.revision,
            committedAt: last ? last.createdAt.getTime() : Date.parse(state.document.updatedAt),
            acked: new Map(),
            presence: new Map(),
            comments: yield* documents.comments(documentId),
            frames: yield* PubSub.unbounded<SheetFrame>(),
            conversationId: state.document.conversationId,
            projectId: state.document.projectId,
            subscribers: 0,
            touched: now,
            changedPending: false,
          };
          entries.set(documentId, entry);
          return { entry, document: state.document };
        });

      /** A client's last sequence number: the entry's when known, else storage's. */
      const lastSeq = (
        tx: Pick<DbTx, "select">,
        documentId: string,
        entry: Entry,
        clientId: string,
      ) =>
        Effect.gen(function* () {
          const known = entry.acked.get(clientId);
          if (known !== undefined) return known;
          const [row] = yield* tx
            .select({ lastSeq: sheetClients.lastSeq })
            .from(sheetClients)
            .where(
              and(eq(sheetClients.documentId, documentId), eq(sheetClients.clientId, clientId)),
            )
            .pipe(Effect.orDie);
          return row?.lastSeq ?? 0;
        });

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

      /**
       * Applies one client's changes that follow its last sequence number, in
       * order, and stores them. Caller holds the row lock and the entry's.
       */
      const store = (
        tx: DbTx,
        documentId: string,
        entry: Entry,
        author: Author,
        changes: ReadonlyArray<SheetChange>,
      ) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const folded = foldChanges(entry.doc, entry.revision, changes);
          const kept = folded.applied.map((change) => ({
            change,
            createdAt: now,
            bytes: sizeOf(change),
          }));
          const last = changes.at(-1);
          if (last)
            yield* tx
              .insert(sheetClients)
              .values({ documentId, clientId: last.clientId, lastSeq: last.seq })
              .onConflictDoUpdate({
                target: [sheetClients.documentId, sheetClients.clientId],
                set: { lastSeq: last.seq, updatedAt: sql`now()` },
              })
              .pipe(Effect.orDie);
          const acked = last ? { clientId: last.clientId, seq: last.seq } : null;
          if (!kept.length) {
            const document = (yield* documents.get(author.userId, documentId, tx))!;
            return {
              document,
              doc: entry.doc,
              kept,
              committedAt: entry.committedAt,
              compacted: null,
              acked,
              refused: folded.refused,
              dropped: folded.dropped,
            } satisfies Stored;
          }
          yield* documents.appendSteps(
            tx,
            kept.map((each, index) => ({
              documentId,
              revision: entry.revision + index + 1,
              step: { ...each.change },
              clientId: each.change.clientId,
              origin: author.origin,
              userId: author.userId,
              generationId: author.generationId,
            })),
          );
          const all = [...entry.steps, ...kept];
          const count = compactionPoint(all, now);
          let compacted: Stored["compacted"] = null;
          if (count) {
            const snapshot = replay(
              entry.snapshot,
              entry.snapshotRevision,
              all.slice(0, count).map((each) => each.change),
            );
            compacted = { snapshot, revision: entry.snapshotRevision + count };
            yield* documents.compact(tx, documentId, { ...snapshot }, compacted.revision);
          }
          const document = yield* documents.write(tx, author.userId, documentId, {
            revision: entry.revision + kept.length,
            lastEditedBy: author.origin,
            lastEditorUserId: author.userId,
          });
          return {
            document,
            doc: folded.doc,
            kept,
            committedAt: now,
            compacted,
            acked,
            refused: folded.refused,
            dropped: folded.dropped,
          } satisfies Stored;
        });

      /** Moves the entry to what was just committed and tells every editor, the sender included. */
      const settle = (documentId: string, entry: Entry, stored: Stored) =>
        Effect.suspend(() => {
          if (stored.acked) entry.acked.set(stored.acked.clientId, stored.acked.seq);
          if (!stored.kept.length) return Effect.void;
          entry.doc = stored.doc;
          entry.steps.push(...stored.kept);
          entry.revision += stored.kept.length;
          entry.committedAt = stored.committedAt;
          if (stored.compacted) {
            entry.steps.splice(0, stored.compacted.revision - entry.snapshotRevision);
            entry.snapshot = stored.compacted.snapshot;
            entry.snapshotRevision = stored.compacted.revision;
          }
          return PubSub.publish(entry.frames, {
            type: "changes",
            changes: stored.kept.map((each) => each.change),
            revision: entry.revision,
            moment: momentOf(documentId, entry),
          });
        });

      /**
       * One write under the document's lock: `prepare` picks the changes in
       * the transaction. A stale entry is rebuilt once; a second mismatch is a
       * real defect.
       */
      const write = <A, E, R>(
        userId: string,
        documentId: string,
        guard: DocumentWriteGuard<E, R> | undefined,
        body: (
          tx: DbTx,
          entry: Entry,
          document: EditableDocument,
        ) => Effect.Effect<{ stored: Stored | null; result: A }, DocumentError, R>,
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
                return yield* body(tx, entry, locked);
              }),
            );
            if (outcome.stored) yield* settle(documentId, entry, outcome.stored);
            return { ...outcome, entry };
          }),
        );
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
        input: CreateSheetInput,
        guard?: DocumentWriteGuard<E, R>,
      ) =>
        Effect.gen(function* () {
          const parsed = yield* decode(CreateSheetInput, "invalid sheet")(input);
          const owner = parsed.projectId
            ? { projectId: parsed.projectId }
            : parsed.conversationId
              ? { conversationId: parsed.conversationId }
              : null;
          if (!owner || (parsed.projectId && parsed.conversationId))
            return yield* new DocumentRejected({
              reason: "a document belongs to a chat or a project",
            });
          const locale = SHEET_LOCALES.find((each) => each.id === parsed.locale)?.id ?? "en-US";
          const timeZone =
            parsed.timeZone && validTimeZone(parsed.timeZone) ? parsed.timeZone : "UTC";
          const doc = emptyDoc("Sheet1", { locale, timeZone });
          const document = yield* transaction((tx) =>
            Effect.gen(function* () {
              if (guard) yield* guard(tx);
              yield* requireDocuments(userId, tx);
              if ("conversationId" in owner)
                yield* documents.lockConversation(tx, userId, owner.conversationId);
              else yield* lockProjectForEditing(tx, userId, owner.projectId);
              return yield* documents.create(tx, userId, owner, {
                title: parsed.title,
                kind: "sheet",
                createdByMessageId:
                  "conversationId" in owner ? (parsed.createdByMessageId ?? null) : null,
                lastEditedBy: parsed.by ?? "model",
                snapshot: { ...doc },
              });
            }),
          );
          yield* documentChanged(userId, document);
          return document;
        });

      const push = Effect.fn("SheetService.push")(function* (
        userId: string,
        input: PushSheetInput,
      ) {
        const parsed = yield* decode(PushSheetInput, "invalid sheet update")(input);
        const changes: SheetChange[] = [];
        for (const each of parsed.changes ?? []) {
          let json: unknown;
          try {
            json = JSON.parse(each);
          } catch {
            return yield* new DocumentRejected({ reason: "a change is not JSON" });
          }
          const checked = parseChange(json);
          if (!checked.ok) return yield* new DocumentRejected({ reason: checked.error });
          if (checked.change.clientId !== parsed.clientId)
            return yield* new DocumentRejected({ reason: "a change from another client" });
          changes.push(checked.change);
        }
        if (parsed.cursor) {
          const cursor = parsed.cursor;
          yield* exclusive(parsed.documentId)(
            Effect.gen(function* () {
              const { entry } = yield* load(userId, parsed.documentId);
              // Labelled by who is signed in, never by what the client says.
              const presence: SheetPresence = {
                ...cursor,
                user: presenceUser({ id: userId, name: yield* nameOf(userId) }),
              };
              entry.presence.set(parsed.clientId, presence);
              yield* PubSub.publish(entry.frames, {
                type: "presence",
                clientId: parsed.clientId,
                presence,
              });
            }),
          );
        }
        if (!changes.length) {
          const { entry } = yield* exclusive(parsed.documentId)(load(userId, parsed.documentId));
          const acked = yield* lastSeq(db, parsed.documentId, entry, parsed.clientId);
          entry.acked.set(parsed.clientId, acked);
          return { revision: entry.revision, acked, refused: [] } satisfies PushSheetResult;
        }
        const { result, entry: written } = yield* write<
          Omit<PushSheetResult, "revision">,
          never,
          never
        >(userId, parsed.documentId, undefined, (tx, entry, document) =>
          Effect.gen(function* () {
            if (!document.canEdit)
              return yield* new DocumentRejected({
                reason: "this document is read-only for you",
              });
            const last = yield* lastSeq(tx, parsed.documentId, entry, parsed.clientId);
            // A resend is acknowledged, not applied again; a gap waits for what is missing.
            const next: SheetChange[] = [];
            for (const change of changes) {
              if (change.seq <= last) continue;
              if (change.seq !== last + next.length + 1) break;
              next.push(change);
            }
            if (!next.length) return { stored: null, result: { acked: last, refused: [] } };
            const stored = yield* store(
              tx,
              parsed.documentId,
              entry,
              { origin: "user", userId, generationId: null },
              next,
            );
            return { stored, result: { acked: stored.acked!.seq, refused: stored.refused } };
          }),
        );
        yield* documentChangedSoon(userId, parsed.documentId, written);
        return { revision: written.revision, ...result } satisfies PushSheetResult;
      });

      const change = <A, E = never, R = never>(
        userId: string,
        input: { documentId: string; clientId: string; generationId: string | null },
        guard: DocumentWriteGuard<E, R> | undefined,
        decide: (
          doc: SheetDoc,
          document: EditableDocument,
        ) => Effect.Effect<{ result: A; ops: ReadonlyArray<SheetOp> | null }, DocumentRejected>,
      ) =>
        Effect.gen(function* () {
          const { result, stored: committed } = yield* write(
            userId,
            input.documentId,
            guard,
            (tx, entry, document) =>
              Effect.gen(function* () {
                const decided = yield* decide(entry.doc, document);
                if (!decided.ops?.length)
                  return {
                    stored: null,
                    result: { result: decided.result, document, refused: null, dropped: [] },
                  };
                const seq = (yield* lastSeq(tx, input.documentId, entry, input.clientId)) + 1;
                const stored = yield* store(
                  tx,
                  input.documentId,
                  entry,
                  { origin: "model", userId, generationId: input.generationId },
                  [{ clientId: input.clientId, seq, ops: decided.ops }],
                );
                return {
                  stored,
                  result: {
                    result: decided.result,
                    document: stored.document,
                    refused: stored.refused[0]?.reason ?? null,
                    dropped: stored.dropped,
                  },
                };
              }),
          );
          if (committed?.kept.length) yield* documentChanged(userId, result.document);
          return result;
        });

      /** Puts a new thread on its cell, as a change of the writer's own. */
      const anchor = (
        tx: DbTx,
        documentId: string,
        entry: Entry,
        author: Author,
        clientId: string,
        thread: string,
        cell: { sh: string; r: string; c: string },
      ) =>
        Effect.gen(function* () {
          const seq = (yield* lastSeq(tx, documentId, entry, clientId)) + 1;
          return yield* store(tx, documentId, entry, author, [
            { clientId, seq, ops: [{ op: "anchor", thread, at: cell }] },
          ]);
        });
      /**
       * One change to a sheet's comments, by someone who may edit it, then
       * every comment to every open editor.
       */
      const commentWrite = <A, E = never, R = never>(
        userId: string,
        documentId: string,
        guard: DocumentWriteGuard<E, R> | undefined,
        body: (
          tx: DbTx,
          entry: Entry,
        ) => Effect.Effect<{ stored: Stored | null; result: A }, DocumentError, R>,
      ) =>
        Effect.gen(function* () {
          const { result, entry } = yield* write(userId, documentId, guard, (tx, held, document) =>
            Effect.gen(function* () {
              if (!document.canEdit)
                return yield* new DocumentRejected({
                  reason: "this document is read-only for you",
                });
              const out = yield* body(tx, held);
              const comments = yield* documents.comments(documentId, tx);
              return { stored: out.stored, result: { value: out.result, comments } };
            }),
          );
          entry.comments = result.comments;
          yield* PubSub.publish(entry.frames, { type: "comments", comments: result.comments });
          return result.value;
        });

      const comment = Effect.fn("SheetService.comment")(function* (
        userId: string,
        input: CommentInput,
      ) {
        const parsed = yield* decode(CommentInput, "invalid comment")(input);
        yield* commentWrite(userId, parsed.documentId, undefined, (tx, entry) =>
          Effect.gen(function* () {
            const started = yield* personComment(documents, userId, parsed)(tx);
            if (!started) return { stored: null, result: undefined };
            if (!parsed.cell || !cellExists(entry.doc, parsed.cell))
              return yield* new DocumentRejected({
                reason: "a new thread on a sheet names its cell",
              });
            const stored = yield* anchor(
              tx,
              parsed.documentId,
              entry,
              { origin: "user", userId, generationId: null },
              personClient(userId),
              parsed.threadId,
              parsed.cell,
            );
            return { stored, result: undefined };
          }),
        );
      });
      const resolveThread = Effect.fn("SheetService.resolveThread")(function* (
        userId: string,
        input: ResolveThreadInput,
      ) {
        const parsed = yield* decode(ResolveThreadInput, "invalid thread")(input);
        yield* commentWrite(userId, parsed.documentId, undefined, (tx) =>
          threadResolution(
            documents,
            parsed,
          )(tx).pipe(Effect.as({ stored: null, result: undefined })),
        );
      });
      const deleteComment = Effect.fn("SheetService.deleteComment")(function* (
        userId: string,
        input: DeleteCommentInput,
      ) {
        const parsed = yield* decode(DeleteCommentInput, "invalid comment")(input);
        yield* commentWrite(userId, parsed.documentId, undefined, (tx) =>
          commentDeletion(
            documents,
            userId,
            parsed,
          )(tx).pipe(Effect.as({ stored: null, result: undefined })),
        );
      });
      const assistantComment = <E, R>(
        userId: string,
        input: {
          documentId: string;
          thread?: string | undefined;
          cell?: { sh: string; r: string; c: string } | undefined;
          quote?: string | undefined;
          body: string;
        },
        guard: DocumentWriteGuard<E, R>,
      ) =>
        commentWrite<
          | { outcome: "commented"; thread: string }
          | { outcome: "not_found" | "invalid"; message: string },
          E,
          R
        >(userId, input.documentId, guard, (tx, entry) =>
          Effect.gen(function* () {
            const current = yield* documents.comments(input.documentId, tx);
            if (input.thread) {
              if (!current.some((each) => each.id === input.thread && each.threadId === each.id))
                return {
                  stored: null,
                  result: {
                    outcome: "not_found" as const,
                    message: "No thread with that id. Its id is on <thread> in the trailing data.",
                  },
                };
              yield* documents.addComment(tx, {
                id: uuidv7(),
                documentId: input.documentId,
                threadId: input.thread,
                userId: null,
                origin: "model",
                body: input.body,
              });
              return {
                stored: null,
                result: { outcome: "commented" as const, thread: input.thread },
              };
            }
            if (!input.cell || !cellExists(entry.doc, input.cell))
              return {
                stored: null,
                result: {
                  outcome: "invalid" as const,
                  message: "A new comment on a sheet needs cell, as the view addresses it.",
                },
              };
            const thread = uuidv7();
            yield* documents.addComment(tx, {
              id: thread,
              documentId: input.documentId,
              threadId: thread,
              userId: null,
              origin: "model",
              body: input.body,
              quote: input.quote ?? null,
            });
            const stored = yield* anchor(
              tx,
              input.documentId,
              entry,
              { origin: "model", userId, generationId: null },
              `a.${input.documentId}`.slice(0, 64),
              thread,
              input.cell,
            );
            return { stored, result: { outcome: "commented" as const, thread } };
          }),
        );

      const subscribe = Effect.fn("SheetService.subscribe")(function* (
        userId: string,
        documentId: string,
        options: { revision: number | null; clientId: string | null },
      ) {
        if (!(yield* policy.can(userId, "documents"))) return null;
        const found = yield* documents.get(userId, documentId);
        if (found?.kind !== "sheet") return null;
        const gone: Stream.Stream<SheetFrame> = Stream.make({ type: "gone" });
        const ownPresence = (frame: SheetFrame) =>
          frame.type === "presence" && frame.clientId === options.clientId;
        return Stream.unwrap(
          exclusive(documentId)(
            Effect.gen(function* () {
              const { entry } = yield* load(userId, documentId);
              // Subscribed before the catch-up is taken, and under the lock, so
              // no change falls between the two.
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
              const moment = momentOf(documentId, entry);
              const catchUp: SheetFrame =
                from !== null && from >= entry.snapshotRevision && from <= entry.revision
                  ? {
                      type: "changes",
                      changes: entry.steps
                        .slice(from - entry.snapshotRevision)
                        .map((each) => each.change),
                      revision: entry.revision,
                      moment,
                    }
                  : {
                      type: "reset",
                      doc: entry.doc,
                      revision: entry.revision,
                      moment,
                      acked:
                        options.clientId === null
                          ? null
                          : yield* lastSeq(db, documentId, entry, options.clientId),
                    };
              const others: SheetFrame[] = [...entry.presence]
                .filter(([clientId]) => clientId !== options.clientId)
                .map(([clientId, presence]) => ({ type: "presence", clientId, presence }));
              let lostAccess = false;
              const revoked = Effect.gen(function* () {
                while (true) {
                  yield* Effect.sleep(ACCESS_RECHECK);
                  if (!(yield* documents.get(userId, documentId))) {
                    lostAccess = true;
                    return;
                  }
                }
              });
              return Stream.make(
                catchUp,
                { type: "comments", comments: entry.comments } satisfies SheetFrame,
                ...others,
              ).pipe(
                Stream.concat(
                  Stream.fromSubscription(subscription).pipe(
                    Stream.filter((frame) => !ownPresence(frame)),
                    Stream.interruptWhen(revoked),
                  ),
                ),
                Stream.concat(Stream.suspend(() => (lostAccess ? gone : Stream.empty))),
              );
            }),
          ).pipe(Effect.catchTag("DocumentNotAvailable", () => Effect.succeed(gone))),
        );
      });

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

      return SheetService.of({
        create,
        read: Effect.fn("SheetService.read")(function* (userId, documentId) {
          if (!(yield* policy.can(userId, "documents"))) return null;
          return yield* exclusive(documentId)(
            load(userId, documentId).pipe(
              Effect.map(({ entry, document }) => ({
                document,
                doc: entry.doc,
                revision: entry.revision,
                moment: momentOf(documentId, entry),
                comments: entry.comments,
              })),
            ),
          ).pipe(Effect.catchTag("DocumentNotAvailable", () => Effect.succeed(null)));
        }),
        change,
        push,
        subscribe,
        comment,
        resolveThread,
        deleteComment,
        assistantComment,
      });
    }),
  ).pipe(Layer.provide(DocumentRepo.layer));
}
