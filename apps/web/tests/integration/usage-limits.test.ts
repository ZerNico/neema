import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql, type SQL } from "drizzle-orm";
import { Effect, ManagedRuntime, Stream } from "effect";
import { Response as AiResponse } from "effect/ai";
import { uuidv7 } from "uuidv7";
import { messages, usageEvents, user, userApprovals } from "~/db/schema/index.ts";
import { ChatService } from "~/modules/chat/server/service.ts";
import { StreamEngine } from "~/modules/chat/server/streaming.ts";
import { GroupRepo } from "~/modules/groups/server/repo.ts";
import { UsageLimits } from "~/modules/limits/server/service.ts";
import type { AiGateway } from "~/modules/providers/server/gateway.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { Db } from "~/server/db.ts";
import { english } from "~/i18n/localized.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";
import { engineLayer } from "./engine-harness.ts";

process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

let database: TestDatabase;
type Services = ChatService | StreamEngine | GroupRepo | UsageLimits | ProviderRepo | Db;
let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>;
let providerId: string;

const gateway = {
  streamChat: () =>
    Stream.make(
      AiResponse.makePart("text-delta", { id: "t", delta: "answer" }),
      AiResponse.makePart("finish", {
        reason: "stop",
        usage: new AiResponse.Usage({
          inputTokens: {
            uncached: undefined,
            total: 10,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 5, text: undefined, reasoning: undefined },
        }),
        metadata: { modelClient: { cost: 1 } },
      }),
    ),
} satisfies Partial<AiGateway["Service"]>;

beforeAll(async () => {
  database = await createTestDatabase();
  runtime = ManagedRuntime.make(engineLayer(database.url, { gateway }));
  providerId = uuidv7();
  await run(
    Effect.gen(function* () {
      const db = yield* Db;
      yield* db.execute(
        `insert into providers (id, name, preset, base_url, api_key_ciphertext)
         values ('${providerId}', 'Prov', 'openrouter', 'http://x', 'x')` as never,
      );
    }),
  );
}, 180_000);

afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});

const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  runtime.runPromise(effect as never) as Promise<A>;

const makeUser = (role: "user" | "admin" = "user") =>
  run(
    Effect.gen(function* () {
      const db = yield* Db;
      const userId = uuidv7();
      yield* db.insert(user).values({ id: userId, name: "Test", email: `${userId}@t.io`, role });
      yield* db.insert(userApprovals).values({ userId, status: "approved" });
      return userId;
    }),
  );

const makeModel = (name = `Model ${uuidv7().slice(-4)}`) =>
  run(
    Effect.flatMap(ProviderRepo, (providers) =>
      providers.createModel({
        providerId,
        modelKey: `key-${uuidv7()}`,
        displayName: name,
        type: "chat",
        contextLength: null,
        embeddingDimensions: null,
        capabilities: {
          imageOutput: false,
          reasoning: false,
          tools: false,
          vision: false,
          files: false,
        },
        pricing: null,
        enabled: true,
        access: "public",
        groupIds: [],
      }),
    ),
  );

/** A settled ledger row, `daysAgo` before now by the database clock. */
const spend = (
  userId: string,
  modelId: string,
  input: {
    cost?: number;
    status?: "complete" | "error";
    daysAgo?: number;
    kind?: "chat" | "title";
    /** When it settled, instead of `daysAgo`. */
    at?: SQL;
    generationId?: string;
  } = {},
) =>
  run(
    Effect.gen(function* () {
      const db = yield* Db;
      yield* db.insert(usageEvents).values({
        id: uuidv7(),
        userId,
        kind: input.kind ?? "chat",
        modelId,
        modelName: "Model",
        status: input.status ?? "complete",
        cost: input.cost ?? 0,
        ...(input.generationId ? { generationId: input.generationId } : {}),
        createdAt: input.at ?? sql`now() - ${`${input.daysAgo ?? 0} days`}::interval`,
      });
    }),
  );

const limits = <A, E>(f: (service: UsageLimits["Service"]) => Effect.Effect<A, E>) =>
  run(Effect.flatMap(UsageLimits, f));

/** A result as JSON with its reason in English, which JSON alone would drop as a function. */
const shown = (value: unknown) =>
  JSON.stringify(value, (_key, part) => (typeof part === "function" ? english(part) : part));

const checked = (userId: string, modelId: string) =>
  limits((service) => service.check(userId, modelId).pipe(Effect.result));

const rule = (input: Partial<Parameters<UsageLimits["Service"]["saveRule"]>[0]>) =>
  limits((service) =>
    service.saveRule({
      id: null,
      groupId: null,
      metric: "cost",
      period: "month",
      amount: 10,
      modelIds: null,
      ...input,
    }),
  );

const clearRules = () =>
  limits((service) =>
    Effect.gen(function* () {
      for (const existing of yield* service.rules()) yield* service.deleteRule(existing.id);
      yield* service.setTimeZone("UTC");
    }),
  );

const group = (members: ReadonlyArray<string>) =>
  run(
    Effect.gen(function* () {
      const repo = yield* GroupRepo;
      const created = yield* repo.createGroup(`Group ${uuidv7()}`);
      for (const member of members) yield* repo.addMember(created.id, member);
      return created.id;
    }),
  );

describe("usage limits", () => {
  it("stops answers once this month's cost is used up, and counts nothing from before", async () => {
    await clearRules();
    const person = await makeUser();
    const model = await makeModel();
    await rule({ amount: 10 });
    // Last month's spending never counts towards this one.
    await spend(person, model.id, { cost: 50, daysAgo: 40 });
    await spend(person, model.id, { cost: 6 });
    expect((await checked(person, model.id))._tag).toBe("Success");
    // Every kind of call counts towards cost, a title too.
    await spend(person, model.id, { cost: 4, kind: "title" });
    const refused = await checked(person, model.id);
    expect(refused._tag).toBe("Failure");
    expect(shown(refused)).toMatch(/this month’s limit of \$10\.00/);
    // Nobody else is touched, and admins are never limited.
    expect((await checked(await makeUser(), model.id))._tag).toBe("Success");
    const admin = await makeUser("admin");
    await spend(admin, model.id, { cost: 100 });
    expect((await checked(admin, model.id))._tag).toBe("Success");
  });

  it("lets a group raise, lower or lift a limit, the most generous group winning", async () => {
    await clearRules();
    const model = await makeModel();
    await rule({ amount: 10 });
    const raised = await makeUser();
    const lowered = await makeUser();
    const both = await makeUser();
    const lifted = await makeUser();
    const silent = await makeUser();
    const power = await group([raised, both]);
    const interns = await group([lowered, both]);
    const devs = await group([lifted]);
    await group([silent]);
    await rule({ groupId: power, amount: 50 });
    await rule({ groupId: interns, amount: 5 });
    await rule({ groupId: devs, amount: null });
    for (const person of [raised, lowered, both, lifted, silent])
      await spend(person, model.id, { cost: 20 });
    expect((await checked(raised, model.id))._tag).toBe("Success");
    expect((await checked(lowered, model.id))._tag).toBe("Failure");
    expect((await checked(both, model.id))._tag).toBe("Success");
    expect((await checked(lifted, model.id))._tag).toBe("Success");
    // A group that says nothing about a limit leaves everyone's in place.
    expect((await checked(silent, model.id))._tag).toBe("Failure");
  });

  it("counts answers per model, leaving failed attempts and other models out", async () => {
    await clearRules();
    const person = await makeUser();
    const opus = await makeModel("Opus");
    const other = await makeModel();
    await rule({ metric: "answers", period: "day", amount: 2, modelIds: [opus.id] });
    await spend(person, opus.id);
    await spend(person, opus.id, { status: "error" });
    await spend(person, opus.id, { kind: "title" });
    expect((await checked(person, opus.id))._tag).toBe("Success");
    await spend(person, opus.id);
    const refused = await checked(person, opus.id);
    expect(shown(refused)).toMatch(/today’s limit of 2 answers with Opus/);
    expect((await checked(person, other.id))._tag).toBe("Success");
    const standing = await limits((service) => service.standing(person));
    expect(standing).toEqual([
      expect.objectContaining({
        metric: "answers",
        used: 2,
        amount: 2,
        reached: true,
        models: [{ id: opus.id, name: "Opus" }],
      }),
    ]);
  });

  it("starts each period in the instance's time zone", async () => {
    await clearRules();
    const person = await makeUser();
    await rule({ period: "day" });
    await rule({ period: "week" });
    await limits((service) => service.setTimeZone("Asia/Tokyo"));
    const standing = await limits((service) => service.standing(person));
    const local = (iso: string) =>
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Tokyo",
        weekday: "long",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(iso));
    const [day, week] = standing;
    expect(local(day!.resetsAt)).toMatch(/00:00$/);
    expect(local(week!.resetsAt)).toBe("Monday 00:00");
    expect(
      shown(await limits((service) => service.setTimeZone("Mars/Olympus").pipe(Effect.result))),
    ).toMatch(/unknown/);
    // An offset Intl takes reads the other way round in Postgres, so only names are taken.
    expect(
      shown(await limits((service) => service.setTimeZone("+05:30").pipe(Effect.result))),
    ).toMatch(/unknown/);
  });

  it("counts from the start of the day where the instance is, not where the server is", async () => {
    await clearRules();
    const person = await makeUser();
    const model = await makeModel();
    await rule({ metric: "answers", period: "day", amount: 1 });
    await limits((service) => service.setTimeZone("Asia/Tokyo"));
    const tokyoMidnight = sql`(date_trunc('day', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo')`;
    // A minute before Tokyo's midnight was yesterday there, whatever the day is in UTC.
    await spend(person, model.id, { at: sql`${tokyoMidnight} - interval '1 minute'` });
    expect((await checked(person, model.id))._tag).toBe("Success");
    await spend(person, model.id, { at: sql`${tokyoMidnight} + interval '1 minute'` });
    expect((await checked(person, model.id))._tag).toBe("Failure");
  });

  it("never counts a research run's own row as an answer", async () => {
    await clearRules();
    const person = await makeUser();
    const model = await makeModel();
    await rule({ metric: "answers", period: "day", amount: 1 });
    await spend(person, model.id, { generationId: uuidv7(), cost: 3 });
    expect((await checked(person, model.id))._tag).toBe("Success");
    // Its cost still counts.
    await rule({ period: "day", amount: 2 });
    expect((await checked(person, model.id))._tag).toBe("Failure");
  });

  it("moves a group's change to other models, and drops it when the limit counts something else", async () => {
    await clearRules();
    const person = await makeUser();
    const model = await makeModel();
    const monthly = await rule({ amount: 10 });
    const power = await group([person]);
    await rule({ groupId: power, amount: 50 });
    // Only for one model now: the group's raise follows it there.
    await limits((service) =>
      service.saveRule({ ...monthly, id: monthly.id, modelIds: [model.id] }),
    );
    expect(await limits((service) => service.limitsFor(person))).toEqual([
      expect.objectContaining({ period: "month", amount: 50, modelIds: [model.id] }),
    ]);
    // Per week, $50 a month says nothing about it, so the raise goes.
    await limits((service) =>
      service.saveRule({
        ...monthly,
        id: monthly.id,
        period: "week",
        amount: 5,
        modelIds: [model.id],
      }),
    );
    expect(await limits((service) => service.limitsFor(person))).toEqual([
      expect.objectContaining({ period: "week", amount: 5 }),
    ]);
    expect((await limits((service) => service.rules())).length).toBe(1);
  });

  it("drops a group's change with everyone's limit, unless another rule still means it", async () => {
    await clearRules();
    const person = await makeUser();
    const first = await rule({ amount: 10 });
    const power = await group([person]);
    await rule({ groupId: power, amount: 50 });
    await limits((service) => service.deleteRule(first.id));
    expect(await limits((service) => service.limitsFor(person))).toEqual([]);
    expect((await limits((service) => service.rules())).length).toBe(0);
    // A group's No limit lifts only a limit everyone has.
    expect(
      shown(
        await limits((service) =>
          service
            .saveRule({
              id: null,
              groupId: power,
              metric: "cost",
              period: "day",
              amount: null,
              modelIds: null,
            })
            .pipe(Effect.result),
        ),
      ),
    ).toMatch(/only lifts one of everyone/);
  });

  it("names the limit that resets last when several are used up", async () => {
    await clearRules();
    const person = await makeUser();
    const model = await makeModel();
    await rule({ period: "day", amount: 1 });
    await rule({ period: "month", amount: 1 });
    await spend(person, model.id, { cost: 5 });
    expect(shown(await checked(person, model.id))).toMatch(/this month’s limit/);
  });

  it("refuses an admin's rule that could not hold or would repeat another", async () => {
    await clearRules();
    const model = await makeModel();
    const refusal = (input: Parameters<typeof rule>[0]) =>
      limits((service) =>
        service
          .saveRule({
            id: null,
            groupId: null,
            metric: "cost",
            period: "month",
            amount: 10,
            modelIds: null,
            ...input,
          })
          .pipe(Effect.result),
      ).then((result) => shown(result));
    expect(await refusal({ amount: null })).toMatch(/need an amount/);
    expect(await refusal({ amount: 0 })).toMatch(/above zero/);
    expect(await refusal({ metric: "answers", amount: 1.5 })).toMatch(/whole number/);
    expect(await refusal({ modelIds: [] })).toMatch(/at least one model/);
    expect(await refusal({ modelIds: ["gone"] })).toMatch(/model is gone/);
    await rule({ modelIds: [model.id] });
    expect(await refusal({ modelIds: [model.id] })).toMatch(/already a limit/);
  });

  it("refuses a send before anything is written, saying when it opens again", async () => {
    await clearRules();
    const person = await makeUser();
    const model = await makeModel();
    await rule({ metric: "answers", period: "day", amount: 1 });
    const send = (id: string) =>
      run(
        Effect.flatMap(ChatService, (chat) =>
          chat
            .sendMessage({
              userId: person,
              conversation: { kind: "new", id, mode: "chat" },
              modelId: model.id,
              content: "hello",
              searchEnabled: false,
              researchEnabled: false,
              attachmentIds: [],
            })
            .pipe(Effect.result),
        ),
      );
    const first = await send(uuidv7());
    if (first._tag !== "Success") throw new Error(JSON.stringify(first));
    await run(
      Effect.flatMap(StreamEngine, (engine) =>
        engine.subscribe(first.success.assistantMessageId, 0).pipe(Stream.runCollect),
      ),
    );
    const blockedId = uuidv7();
    const second = await send(blockedId);
    expect(second).toMatchObject({ _tag: "Failure", failure: { _tag: "UsageLimitReached" } });
    const written = await run(
      Effect.flatMap(Db, (db) =>
        db.select({ id: messages.id }).from(messages).where(eq(messages.conversationId, blockedId)),
      ),
    );
    expect(written).toEqual([]);
    // Retrying the answer that went through is a new answer too.
    const retried = await run(
      Effect.flatMap(ChatService, (chat) =>
        chat
          .retryMessage({
            userId: person,
            conversationId: first.success.conversationId,
            messageId: first.success.assistantMessageId,
          })
          .pipe(Effect.result),
      ),
    );
    expect(retried).toMatchObject({ _tag: "Failure", failure: { _tag: "UsageLimitReached" } });
  }, 60_000);
});
