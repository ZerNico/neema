import { readFileSync } from "node:fs";
import { PgClient } from "@effect/sql-pg";
import { eq } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  conversationDrafts,
  conversations,
  messages,
  schedules,
  user,
  userApprovals,
} from "~/db/schema/index.ts";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { CustomToolRepo } from "~/modules/custom-tools/server/repo.ts";
import { DraftRepo } from "~/modules/drafts/server/repo.ts";
import { DraftService } from "~/modules/drafts/server/service.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import type { ScheduleDraft } from "~/modules/schedules/draft-schema.ts";
import { ScheduleDraftService } from "~/modules/schedules/server/draft-service.ts";
import { ScheduleRepo } from "~/modules/schedules/server/repo.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString("base64");
let database: TestDatabase;
type Services = Db | ScheduleDraftService | ScheduleRepo;
let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>;
const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect);

const QuietBus = Layer.succeed(SyncBus, {
  publish: () => Effect.void,
  publishGlobal: () => Effect.void,
  signals: Stream.make({ type: "ready" } as const).pipe(Stream.concat(Stream.never)),
  subscribe: () => Stream.empty,
});

beforeAll(async () => {
  database = await createTestDatabase();
  const infrastructure = Layer.mergeAll(Db.layer, KeyCipher.layer).pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(database.url), maxConnections: 8 })),
  );
  const core = Layer.mergeAll(
    CustomToolRepo.layer,
    AgentRepo.layer,
    DraftRepo.layer,
    ProviderRepo.layer,
    QuietBus,
  ).pipe(Layer.provideMerge(FeaturePolicy.layer), Layer.provideMerge(infrastructure));
  runtime = ManagedRuntime.make(
    ScheduleDraftService.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(core, DraftService.layer.pipe(Layer.provideMerge(core)))),
    ),
  );
}, 180_000);
afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});

/** A person with a "same chat" schedule that has not fired yet, and a chat to draft in. */
const setup = () =>
  run(
    Effect.gen(function* () {
      const db = yield* Db;
      const userId = uuidv7();
      yield* db.insert(user).values({ id: userId, name: "Owner", email: `${userId}@t.io` });
      yield* db.insert(userApprovals).values({ userId, status: "approved" });
      const conversationId = uuidv7();
      const messageId = uuidv7();
      yield* db.insert(conversations).values({ id: conversationId, userId });
      yield* db
        .insert(messages)
        .values({ id: messageId, conversationId, role: "assistant", status: "complete" });
      const schedule = yield* (yield* ScheduleRepo).insert({
        userId,
        name: "Digest",
        prompt: "Summarize.",
        scheduleText: "every day at 7",
        cron: "0 7 * * *",
        timezone: "UTC",
        endAt: null,
        modelId: null,
        agentId: null,
        imageModelId: null,
        searchEnabled: false,
        researchEnabled: false,
        collectionIds: [],
        skillIds: [],
        chatMode: "same",
        chatId: null,
        integrationGrants: [],
        notify: "conditional",
        nextFireAt: null,
      });
      return { userId, conversationId, messageId, schedule };
    }),
  );

const open = (context: Awaited<ReturnType<typeof setup>>) =>
  run(
    Effect.flatMap(ScheduleDraftService, (service) =>
      service.open(
        context.userId,
        {
          conversationId: context.conversationId,
          createdByMessageId: context.messageId,
          scheduleId: context.schedule.id,
        },
        () => Effect.void,
      ),
    ),
  ).then((result) => result.draft);

const save = (userId: string, draft: ScheduleDraft) =>
  run(
    Effect.flatMap(ScheduleDraftService, (service) =>
      service.save(userId, { draftId: draft.id, expectedRevision: draft.revision }),
    ),
  );

/** What a first fire does to a "same chat" schedule: it makes the chat and keeps it. */
const fireAdopts = (context: Awaited<ReturnType<typeof setup>>) =>
  run(
    Effect.gen(function* () {
      const chatId = uuidv7();
      yield* (yield* Db).insert(conversations).values({ id: chatId, userId: context.userId });
      yield* (yield* ScheduleRepo).adoptChat(context.schedule.id, chatId, null);
      return chatId;
    }),
  );

const storedChat = (scheduleId: string) =>
  run(
    Effect.flatMap(Db, (db) =>
      db.select({ chatId: schedules.chatId }).from(schedules).where(eq(schedules.id, scheduleId)),
    ),
  ).then(([row]) => row?.chatId);

describe("saving a schedule draft", () => {
  it("does not write a chat back over the one a fire adopted after the draft opened", async () => {
    const context = await setup();
    const draft = await open(context);
    expect(draft.settings).toMatchObject({ chatMode: "same", chatId: null, notify: "conditional" });
    const adopted = await fireAdopts(context);

    expect(await save(context.userId, draft)).toMatchObject({ outcome: "schedule_changed" });
    expect(await storedChat(context.schedule.id)).toBe(adopted);

    const reloaded = await run(
      Effect.flatMap(ScheduleDraftService, (service) =>
        service.reload(context.userId, { draftId: draft.id, expectedRevision: draft.revision }),
      ),
    );
    expect(reloaded).toMatchObject({ outcome: "reloaded", draft: { settings: { chatId: adopted } } });
    expect(await save(context.userId, reloaded.draft)).toMatchObject({ outcome: "saved" });
    expect(await storedChat(context.schedule.id)).toBe(adopted);
  });

  it("keeps saving later revisions after its own save moved the schedule on", async () => {
    const context = await setup();
    const first = await save(context.userId, await open(context));
    expect(first).toMatchObject({ outcome: "saved" });
    const patched = await run(
      Effect.flatMap(ScheduleDraftService, (service) =>
        service.patch(context.userId, {
          draftId: first.draft.id,
          expectedRevision: first.draft.revision,
          changes: { name: "Renamed" },
        }),
      ),
    );
    expect(await save(context.userId, patched.draft)).toMatchObject({ outcome: "saved" });
  });
});

describe("completing older schedule drafts", () => {
  it("fills what a draft left out from the schedule it edits, and records its revision", async () => {
    const context = await setup();
    const fresh = uuidv7();
    // As drafts were written before every setting was required.
    const legacy = {
      name: "Digest",
      scheduleText: "every day at 7",
      cron: "0 7 * * *",
      timezone: "UTC",
      endAt: null,
      prompt: "Summarize.",
      modelId: null,
      agentId: null,
      searchEnabled: false,
      researchEnabled: false,
      collectionIds: [],
      skillIds: [],
    };
    await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* db.insert(conversationDrafts).values([
          {
            id: uuidv7(),
            conversationId: context.conversationId,
            createdByMessageId: context.messageId,
            kind: "schedule",
            settings: legacy,
            targetId: context.schedule.id,
          },
          {
            id: fresh,
            conversationId: context.conversationId,
            createdByMessageId: context.messageId,
            kind: "schedule",
            settings: { ...legacy, chatMode: "same" },
          },
        ]);
        const migration = readFileSync(
          new URL(
            "../../drizzle/20261025190037_schedule_drafts_complete/migration.sql",
            import.meta.url,
          ),
          "utf8",
        );
        yield* db.execute(migration as never);
      }),
    );
    const rows = await run(
      Effect.flatMap(Db, (db) =>
        db
          .select({
            id: conversationDrafts.id,
            settings: conversationDrafts.settings,
            targetRevision: conversationDrafts.targetRevision,
          })
          .from(conversationDrafts)
          .where(eq(conversationDrafts.conversationId, context.conversationId)),
      ),
    );
    const edit = rows.find((row) => row.id !== fresh)!;
    const created = rows.find((row) => row.id === fresh)!;
    // The schedule's own mode survives: before, a missing mode saved it back as `new`.
    expect(edit).toMatchObject({
      targetRevision: 1,
      settings: {
        chatMode: "same",
        chatId: null,
        notify: "conditional",
        imageModelId: null,
        integrationGrants: [],
      },
    });
    // A draft that named its mode meant no chat by leaving it out.
    expect(created).toMatchObject({
      targetRevision: null,
      settings: { chatMode: "same", chatId: null, notify: "always", integrationGrants: [] },
    });
  });
});
