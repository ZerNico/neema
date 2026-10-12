import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgClient } from "@effect/sql-pg";
import { eq } from "drizzle-orm";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { TestClock } from "effect/testing";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  groups,
  groupMembers,
  projectMembers,
  projects,
  session,
  user,
  userApprovals,
} from "~/db/schema/index.ts";
import { fsBlobStoreLayer } from "~/modules/attachments/server/fs-blob-store.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { DocumentRepo } from "~/modules/documents/server/document-repo.ts";
import { DocumentService } from "~/modules/documents/server/document-service.ts";
import { SheetService } from "~/modules/documents/sheet/server/sheet-service.ts";
import type { DocumentFrame } from "~/modules/documents/schema.ts";
import type { SheetFrame } from "~/modules/documents/sheet/schema.ts";
import { ALL_CAPABILITIES } from "~/modules/groups/policy.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { seedEligibleSession } from "../fixtures/eligible-session.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

process.env.BLOB_STORE_ROOT = mkdtempSync(join(tmpdir(), "feed-auth-it-"));
type Services = Db | DocumentService | SheetService | TestClock.TestClock;
let database: TestDatabase;
let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>;
const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect);

beforeAll(async () => {
  database = await createTestDatabase();
  // Advance the feed timer, not the real socket connection watchdog.
  const infrastructure = Db.layer.pipe(
    Layer.provideMerge(
      PgClient.layerFrom(
        TestClock.withLive(PgClient.make({ url: Redacted.make(database.url), maxConnections: 8 })),
      ),
    ),
  );
  const bus = Layer.succeed(SyncBus, {
    publish: () => Effect.void,
    publishGlobal: () => Effect.void,
    signals: Stream.make({ type: "ready" } as const).pipe(Stream.concat(Stream.never)),
    subscribe: () => Stream.empty,
  });
  const core = Layer.mergeAll(DocumentRepo.layer, AttachmentRepo.layer, bus, fsBlobStoreLayer).pipe(
    Layer.provideMerge(FeaturePolicy.layer),
    Layer.provideMerge(infrastructure),
  );
  runtime = ManagedRuntime.make(
    Layer.mergeAll(DocumentService.layer, SheetService.layer).pipe(
      Layer.provideMerge(core),
      Layer.provideMerge(TestClock.layer()),
    ),
  );
}, 120_000);
afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});

const fixture = async (kind: "text" | "sheet") => {
  const owner = uuidv7(),
    reader = uuidv7(),
    projectId = uuidv7(),
    groupId = uuidv7();
  await run(
    Effect.gen(function* () {
      const db = yield* Db;
      yield* db
        .insert(user)
        .values([owner, reader].map((id) => ({ id, name: "Feed reader", email: `${id}@t.io` })));
      yield* seedEligibleSession(owner);
      yield* seedEligibleSession(reader);
      yield* db.insert(session).values({
        id: uuidv7(),
        userId: reader,
        token: uuidv7(),
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      yield* db
        .insert(groups)
        .values({ id: groupId, name: groupId, capabilities: ALL_CAPABILITIES });
      yield* db.insert(groupMembers).values({ userId: reader, groupId });
      yield* db.insert(projects).values({ id: projectId, userId: owner, name: "Shared" });
      yield* db.insert(projectMembers).values({ projectId, userId: reader, role: "editor" });
    }),
  );
  const document =
    kind === "text"
      ? (
          await run(
            Effect.flatMap(DocumentService, (s) =>
              s.create(owner, { projectId, title: "Text", content: "Before" }),
            ),
          )
        ).document
      : await run(
          Effect.flatMap(SheetService, (s) => s.create(owner, { projectId, title: "Sheet" })),
        );
  const subscribe: Promise<Stream.Stream<DocumentFrame | SheetFrame> | null> =
    kind === "text"
      ? run(
          Effect.flatMap(DocumentService, (s) =>
            s.subscribe(reader, document.id, {
              sessionId: reader,
              revision: null,
              clientId: "reader",
            }),
          ),
        )
      : run(
          Effect.flatMap(SheetService, (s) =>
            s.subscribe(reader, document.id, {
              sessionId: reader,
              revision: null,
              clientId: "reader",
            }),
          ),
        );
  return { owner, reader, groupId, projectId, document, subscribe };
};

for (const kind of ["text", "sheet"] as const) {
  describe(`${kind} feed authorization`, () => {
    it.each([
      "session deletion",
      "session expiry",
      "rejection",
      "ban",
      "documents feature",
      "membership",
    ] as const)("terminates within the recheck bound after %s", async (revocation) => {
      const f = await fixture(kind);
      const feed = await f.subscribe;
      expect(feed).not.toBeNull();
      const caughtUp = Effect.runSync(Deferred.make<void>());
      const frames: string[] = [];
      await run(
        Effect.gen(function* () {
          const consumer = yield* Stream.runForEach(feed!, (frame) =>
            Effect.gen(function* () {
              frames.push(frame.type);
              if (frame.type === "comments") yield* Deferred.succeed(caughtUp, undefined);
            }),
          ).pipe(Effect.forkChild);
          yield* Deferred.await(caughtUp);
          const db = yield* Db;
          if (revocation === "session deletion")
            yield* db.delete(session).where(eq(session.id, f.reader));
          else if (revocation === "session expiry")
            yield* db
              .update(session)
              .set({ expiresAt: new Date(0) })
              .where(eq(session.id, f.reader));
          else if (revocation === "rejection")
            yield* db
              .update(userApprovals)
              .set({ status: "rejected" })
              .where(eq(userApprovals.userId, f.reader));
          else if (revocation === "ban")
            yield* db.update(user).set({ banned: true }).where(eq(user.id, f.reader));
          else if (revocation === "documents feature")
            yield* db
              .update(groups)
              .set({ capabilities: { ...ALL_CAPABILITIES, documents: false } })
              .where(eq(groups.id, f.groupId));
          else yield* db.delete(projectMembers).where(eq(projectMembers.userId, f.reader));
          yield* TestClock.adjust("30 seconds");
          yield* Fiber.join(consumer);
        }),
      );
      expect(frames).toEqual(["reset", "comments", "gone"]);
      // The other session and project rights cannot rescue this feed's revoked session.
      const remaining = await run(
        Effect.flatMap(Db, (db) => db.select().from(session).where(eq(session.userId, f.reader))),
      );
      expect(remaining.length).toBeGreaterThan(0);
      const after = frames.slice();
      if (kind === "text") {
        await run(
          Effect.flatMap(DocumentService, (s) =>
            s.push(f.owner, {
              documentId: f.document.id,
              clientId: "owner",
              revision: 0,
              steps: [
                JSON.stringify({
                  stepType: "replace",
                  from: 1,
                  to: 1,
                  slice: { content: [{ type: "text", text: "Later " }] },
                }),
              ],
            }),
          ),
        );
      } else {
        await run(
          Effect.flatMap(SheetService, (s) =>
            s.push(f.owner, {
              documentId: f.document.id,
              clientId: "owner",
              changes: [JSON.stringify({ clientId: "owner", seq: 1, ops: [] })],
            }),
          ),
        );
      }
      expect(frames).toEqual(after);
    });

    it("still delivers later edits after an authorized recheck", async () => {
      const f = await fixture(kind);
      const feed = await f.subscribe;
      expect(feed).not.toBeNull();
      const caughtUp = Effect.runSync(Deferred.make<void>());
      const frames: string[] = [];
      await run(
        Effect.gen(function* () {
          const consumer = yield* feed!.pipe(
            Stream.take(3),
            Stream.runForEach((frame) =>
              Effect.gen(function* () {
                frames.push(frame.type);
                if (frame.type === "comments") yield* Deferred.succeed(caughtUp, undefined);
              }),
            ),
            Effect.forkChild,
          );
          yield* Deferred.await(caughtUp);
          yield* TestClock.adjust("30 seconds");
          if (kind === "text") {
            yield* (yield* DocumentService).push(f.owner, {
              documentId: f.document.id,
              clientId: "owner",
              revision: 0,
              steps: [
                JSON.stringify({
                  stepType: "replace",
                  from: 1,
                  to: 1,
                  slice: { content: [{ type: "text", text: "Later " }] },
                }),
              ],
            });
          } else {
            yield* (yield* SheetService).push(f.owner, {
              documentId: f.document.id,
              clientId: "owner",
              changes: [JSON.stringify({ clientId: "owner", seq: 1, ops: [] })],
            });
          }
          yield* Fiber.join(consumer);
        }),
      );
      expect(frames).toEqual(["reset", "comments", kind === "text" ? "steps" : "changes"]);
    });

    it("rechecks catch-up after a guarded write releases the real document mutex", async () => {
      const f = await fixture(kind);
      const feed = await f.subscribe;
      expect(feed).not.toBeNull();
      const entered = Effect.runSync(Deferred.make<void>());
      const release = Effect.runSync(Deferred.make<void>());
      const consuming = Effect.runSync(Deferred.make<void>());
      const guard = () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
      await run(
        Effect.gen(function* () {
          const write =
            kind === "text"
              ? (yield* DocumentService).assistantComment(
                  f.owner,
                  { documentId: f.document.id, target: "missing", body: "Synthetic comment" },
                  guard,
                )
              : (yield* SheetService).assistantComment(
                  f.owner,
                  { documentId: f.document.id, body: "Synthetic comment" },
                  guard,
                );
          const held = yield* write.pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          const consumer = yield* Stream.unwrap(
            Deferred.succeed(consuming, undefined).pipe(Effect.as(feed!)),
          ).pipe(Stream.runCollect, Effect.forkChild);
          try {
            yield* Deferred.await(consuming);
            yield* (yield* Db).delete(session).where(eq(session.id, f.reader));
          } finally {
            yield* Deferred.succeed(release, undefined);
          }
          yield* Fiber.join(held);
          const frames = yield* Fiber.join(consumer);
          expect(frames.map((frame) => frame.type)).toEqual(["gone"]);
        }),
      );
    });

    it("rechecks before catch-up when a prepared feed is consumed after revocation", async () => {
      const f = await fixture(kind);
      const feed = await f.subscribe;
      expect(feed).not.toBeNull();
      await run(
        Effect.gen(function* () {
          yield* (yield* Db).delete(session).where(eq(session.id, f.reader));
          const frames = yield* Stream.runCollect(feed!);
          expect(frames.map((frame) => frame.type)).toEqual(["gone"]);
        }),
      );
    });
  });
}
