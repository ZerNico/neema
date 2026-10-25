import { readFileSync } from "node:fs";
import { PgClient } from "@effect/sql-pg";
import { readableBy } from "~/modules/sharing/server/resources.ts";
import { eq, sql, type SQL } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import {
  AUTH_SETTINGS_ID,
  agents,
  knowledgeCollections,
  signupBootstrap,
  skills,
  user,
  userApprovals,
} from "~/db/schema/index.ts";
import { ALL_CAPABILITIES, CAPABILITY_KEYS } from "~/modules/groups/policy.ts";
import { capabilityAllowedSql, FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { GroupRepo } from "~/modules/groups/server/repo.ts";
import { Db } from "~/server/db.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

let database: TestDatabase;
let runtime: ManagedRuntime.ManagedRuntime<Db | GroupRepo | FeaturePolicy, unknown>;

beforeAll(async () => {
  database = await createTestDatabase();
  const url = database.url;
  const infra = Db.layer.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 5 })),
  );
  runtime = ManagedRuntime.make(
    Layer.mergeAll(FeaturePolicy.layer, GroupRepo.layer).pipe(Layer.provideMerge(infra)),
  );
}, 180_000);

afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});

const run = <A, E>(effect: Effect.Effect<A, E, Db | GroupRepo | FeaturePolicy>) =>
  runtime.runPromise(effect);

const makeUser = (role: "user" | "admin" = "user") =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [row] = yield* db
      .insert(user)
      .values({
        id: uuidv7(),
        name: "Policy test",
        email: `${uuidv7()}@example.test`,
        role,
      })
      .returning({ id: user.id });
    yield* db.insert(userApprovals).values({ userId: row!.id, status: "approved" });
    return row!.id;
  });

describe("feature policy", () => {
  it("uses default only without groups, and admins bypass every restriction", async () => {
    const [member, admin] = await run(Effect.all([makeUser(), makeUser("admin")]));
    const restricted = { ...ALL_CAPABILITIES, webSearch: false, work: false };
    await run(GroupRepo.use((repo) => repo.updateDefaultCapabilities(restricted)));
    const result = await run(
      FeaturePolicy.use((policy) =>
        Effect.all([
          policy.forUser(member),
          policy.forUser(admin),
          policy.can(member, "webSearch"),
        ]),
      ),
    );
    expect(result[0]).toEqual(restricted);
    expect(result[1]).toEqual(ALL_CAPABILITIES);
    expect(result[2]).toBe(false);
    await run(GroupRepo.use((repo) => repo.updateDefaultCapabilities(ALL_CAPABILITIES)));
  });

  it("seeds new groups from the current default and unions only group grants", async () => {
    const member = await run(makeUser());
    const defaults = { ...ALL_CAPABILITIES, work: false, webSearch: false };
    await run(GroupRepo.use((repo) => repo.updateDefaultCapabilities(defaults)));
    const group = await run(GroupRepo.use((repo) => repo.createGroup(`group-${uuidv7()}`)));
    expect(group.capabilities).toEqual(defaults);
    await run(GroupRepo.use((repo) => repo.updateDefaultCapabilities(ALL_CAPABILITIES)));
    await run(GroupRepo.use((repo) => repo.addMember(group.id, member)));
    expect((await run(FeaturePolicy.use((policy) => policy.forUser(member)))).work).toBe(false);
    const other = await run(GroupRepo.use((repo) => repo.createGroup(`group-${uuidv7()}`)));
    await run(GroupRepo.use((repo) => repo.addMember(other.id, member)));
    expect((await run(FeaturePolicy.use((policy) => policy.forUser(member)))).work).toBe(true);
    await run(GroupRepo.use((repo) => repo.removeMember(other.id, member)));
    expect((await run(FeaturePolicy.use((policy) => policy.forUser(member)))).work).toBe(false);
  });

  it("suspends grants for agents, skills and collections when creator loses Create", async () => {
    const [creator, recipient] = await run(Effect.all([makeUser(), makeUser()]));
    const agentId = uuidv7();
    const skillId = uuidv7();
    const collectionId = uuidv7();
    await run(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* db
          .insert(agents)
          .values({ id: agentId, userId: creator, name: "Shared agent", audience: "instance" });
        yield* db.insert(skills).values({
          id: skillId,
          userId: creator,
          name: "Shared skill",
          description: "",
          audience: "instance",
        });
        yield* db.insert(knowledgeCollections).values({
          id: collectionId,
          userId: creator,
          name: "Shared collection",
          audience: "instance",
        });
      }),
    );
    const readable = () =>
      run(
        Effect.gen(function* () {
          const db = yield* Db;
          const [agent] = yield* db
            .select({ id: agents.id })
            .from(agents)
            .where(sql`${agents.id} = ${agentId} and ${readableBy("agent", recipient)}`);
          const [skill] = yield* db
            .select({ id: skills.id })
            .from(skills)
            .where(sql`${skills.id} = ${skillId} and ${readableBy("skill", recipient)}`);
          const [collection] = yield* db
            .select({ id: knowledgeCollections.id })
            .from(knowledgeCollections)
            .where(
              sql`${knowledgeCollections.id} = ${collectionId} and ${readableBy("collection", recipient)}`,
            );
          return [Boolean(agent), Boolean(skill), Boolean(collection)];
        }),
      );
    expect(await readable()).toEqual([true, true, true]);
    const group = await run(GroupRepo.use((repo) => repo.createGroup(`creator-${uuidv7()}`)));
    await run(
      GroupRepo.use((repo) =>
        repo.updateGroupCapabilities(group.id, {
          ...ALL_CAPABILITIES,
          agentsCreate: false,
          knowledgeCreate: false,
          skillsCreate: false,
        }),
      ),
    );
    await run(GroupRepo.use((repo) => repo.addMember(group.id, creator)));
    expect(await readable()).toEqual([false, false, false]);
    await run(GroupRepo.use((repo) => repo.removeMember(group.id, creator)));
    expect(await readable()).toEqual([true, true, true]);
    // A ban suspends them the same way, and lifting it brings them back.
    const ban = (banned: boolean) =>
      run(Effect.flatMap(Db, (db) => db.update(user).set({ banned }).where(eq(user.id, creator))));
    await ban(true);
    expect(await readable()).toEqual([false, false, false]);
    await ban(false);
    expect(await readable()).toEqual([true, true, true]);
    const write = <A>(effect: (db: Effect.Success<typeof Db>) => Effect.Effect<A, unknown>) =>
      run(Effect.flatMap(Db, effect).pipe(Effect.orDie));
    // A ban that has run out suspends nothing.
    await write((db) =>
      db
        .update(user)
        .set({ banned: true, banExpires: sql`now() - interval '1 minute'` })
        .where(eq(user.id, creator)),
    );
    expect(await readable()).toEqual([true, true, true]);
    await write((db) =>
      db.update(user).set({ banned: false, banExpires: null }).where(eq(user.id, creator)),
    );
    // A turned-down approval suspends them, and so does a missing row, unless
    // the account is the bootstrap owner's.
    await write((db) =>
      db.update(userApprovals).set({ status: "rejected" }).where(eq(userApprovals.userId, creator)),
    );
    expect(await readable()).toEqual([false, false, false]);
    await write((db) => db.delete(userApprovals).where(eq(userApprovals.userId, creator)));
    expect(await readable()).toEqual([false, false, false]);
    await write((db) =>
      db
        .insert(signupBootstrap)
        .values({ id: AUTH_SETTINGS_ID, ownerId: creator })
        .onConflictDoUpdate({ target: signupBootstrap.id, set: { ownerId: creator } }),
    );
    expect(await readable()).toEqual([true, true, true]);
  });

  it("matches SQL owner predicates and rejects Create without Use", async () => {
    const member = await run(makeUser());
    const defaults = { ...ALL_CAPABILITIES, agentsUse: false, agentsCreate: false };
    await run(GroupRepo.use((repo) => repo.updateDefaultCapabilities(defaults)));
    expect((await run(GroupRepo.use((repo) => repo.getDefaultCapabilities()))).agentsUse).toBe(
      false,
    );
    const [row] = await run(
      Db.use((db) =>
        db
          .select({ allowed: capabilityAllowedSql(user.id, "agentsUse") })
          .from(user)
          .where(eq(user.id, member)),
      ),
    );
    expect(row?.allowed).toBe(false);
    await expect(
      run(
        GroupRepo.use((repo) =>
          repo.updateDefaultCapabilities({
            ...defaults,
            agentsCreate: true,
          }),
        ),
      ),
    ).rejects.toMatchObject({ _tag: "CapabilitiesRejected" });
    await run(GroupRepo.use((repo) => repo.updateDefaultCapabilities(ALL_CAPABILITIES)));
    const [allowed] = await run(
      Db.use((db) =>
        db
          .select({ allowed: capabilityAllowedSql(sql`${member}`, "agentsUse") })
          .from(user)
          .where(eq(user.id, member)),
      ),
    );
    expect(allowed?.allowed).toBe(true);
  });

  it("refuses a hand-edited Create without Use, after normalising rows from before", async () => {
    const member = await run(makeUser());
    const migration = (folder: string) =>
      readFileSync(new URL(`../../drizzle/${folder}/migration.sql`, import.meta.url), "utf8")
        .split("--> statement-breakpoint")
        .map((statement) => sql.raw(statement));
    const exec = (statement: SQL) =>
      run(Effect.flatMap(Db, (db) => db.execute(statement).pipe(Effect.orDie)));
    const handEdited = sql`update default_capabilities set capabilities = capabilities
      || '{"agentsUse": false, "agentsCreate": true}'::jsonb where id = 1`;
    await expect(exec(handEdited)).rejects.toThrow(/^Failed query: update default_capabilities/);
    expect((await run(GroupRepo.use((repo) => repo.getDefaultCapabilities()))).agentsCreate).toBe(
      true,
    );
    expect((await run(GroupRepo.use((repo) => repo.getDefaultCapabilities()))).agentsUse).toBe(
      true,
    );

    // As a row was before the constraint: readers took Create to imply Use.
    await exec(
      sql`alter table default_capabilities drop constraint default_capabilities_create_requires_use`,
    );
    await exec(sql`alter table groups drop constraint groups_create_requires_use`);
    await exec(handEdited);
    for (const statement of migration("20261025183233_capabilities_create_implies_use"))
      // oxlint-disable-next-line eslint/no-await-in-loop -- Statements run in the migration's order.
      await exec(statement);
    for (const statement of migration("20261025183243_capabilities_create_requires_use_check"))
      // oxlint-disable-next-line eslint/no-await-in-loop -- Statements run in the migration's order.
      await exec(statement);
    const capabilities = await run(FeaturePolicy.use((policy) => policy.forUser(member)));
    expect([capabilities.agentsUse, capabilities.agentsCreate]).toEqual([true, true]);
    await run(GroupRepo.use((repo) => repo.updateDefaultCapabilities(ALL_CAPABILITIES)));
  });

  it("lists exactly what each single check answers", async () => {
    const member = await run(makeUser());
    const defaults = { ...ALL_CAPABILITIES, memory: false, skillsCreate: false };
    await run(GroupRepo.use((repo) => repo.updateDefaultCapabilities(defaults)));
    const listed = await run(FeaturePolicy.use((policy) => policy.forUser(member)));
    const single = await run(
      FeaturePolicy.use((policy) =>
        Effect.all(CAPABILITY_KEYS.map((key) => policy.can(member, key))),
      ),
    );
    expect(listed).toEqual(defaults);
    expect(CAPABILITY_KEYS.map((key) => listed[key])).toEqual(single);
    expect(await run(FeaturePolicy.use((policy) => policy.forUser("missing")))).toEqual(
      Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, false])),
    );
    await run(GroupRepo.use((repo) => repo.updateDefaultCapabilities(ALL_CAPABILITIES)));
  });
});
