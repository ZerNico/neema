import { PgClient } from "@effect/sql-pg";
import { eq } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationConfigs, models, user } from "~/db/schema/index.ts";
import { AnalyticsRepo } from "~/modules/analytics/server/repo.ts";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { EMPTY_AGENT_DRAFT } from "~/modules/agents/draft-schema.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { CustomToolRepo } from "~/modules/custom-tools/server/repo.ts";
import { GroupRepo } from "~/modules/groups/server/repo.ts";
import { KnowledgeRepo } from "~/modules/knowledge/server/repo.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { SharingService } from "~/modules/sharing/server/service.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

// ProviderRepo decrypts stored keys through KeyCipher, which reads this.
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

/**
 * Modules and sharing at the repository layer: what an attempt resolves, what
 * a later edit or deletion changes, and who a module is offered to. Nothing
 * here streams; the toolkit and worker have their own suites.
 */
type Services = ChatRepo | CustomToolRepo | AgentRepo | GroupRepo | SharingService | Db;

let database: TestDatabase;
let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>;
/** messages.model_id is a real FK. */
let modelId: string;

beforeAll(async () => {
  database = await createTestDatabase();
  const url = database.url;

  const InfraLayer = Db.layer.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 5 })),
  );
  const ReposLayer = Layer.mergeAll(
    AnalyticsRepo.layer,
    CustomToolRepo.layer,
    GroupRepo.layer,
    AgentRepo.layer,
    ChatRepo.layer,
    KnowledgeRepo.layer,
    ProviderRepo.layer,
  ).pipe(
    Layer.provideMerge(Layer.mergeAll(AttachmentRepo.layer, KeyCipher.layer)),
    Layer.provideMerge(FeaturePolicy.layer),
    Layer.provideMerge(InfraLayer),
  );
  runtime = ManagedRuntime.make(
    SharingService.layer.pipe(Layer.provideMerge(SyncBus.layer), Layer.provideMerge(ReposLayer)),
  );

  modelId = uuidv7();
  const providerId = uuidv7();
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Db;
      yield* db.execute(
        `insert into providers (id, name, preset, base_url, api_key_ciphertext)
         values ('${providerId}', 'p', 'openrouter', 'http://x', 'x')` as never,
      );
      yield* db.insert(models).values({
        id: modelId,
        providerId,
        modelKey: "m",
        displayName: "M",
        type: "chat",
      });
    }),
  );
}, 180_000);

afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});

const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  runtime.runPromise(effect as never) as Promise<A>;

const makeUser = Effect.fn("test.makeUser")(function* (role: "user" | "admin" = "user") {
  const db = yield* Db;
  const userId = uuidv7();
  yield* db.execute(
    `insert into "user" (id, name, email, role)
     values ('${userId}', 'Test', '${userId}@t.io', '${role}')` as never,
  );
  yield* db.execute(
    `insert into user_approvals (user_id, status) values ('${userId}', 'approved')` as never,
  );
  return userId;
});

const build = (label: string, slug = "catalog") => ({
  source: `source ${label}`,
  dependencies: [],
  compiled: `compiled ${label}`,
  functions: [
    {
      key: "lookup",
      name: "Lookup",
      description: "Look up a value.",
      modelName: `custom_${slug}__lookup`,
      parametersSchema: { type: "object", properties: {} },
    },
  ],
});

describe("custom tool modules across attempts", () => {
  it("resolves the module as it is now; disable and delete only touch future attempts", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tools = yield* CustomToolRepo;
        const userId = yield* makeUser();
        const created = yield* tools.create({
          slug: `catalog_${userId.slice(-8)}`,
          name: "Catalog",
          description: "Catalog functions.",
          createdBy: userId,
          build: build("one"),
        });
        const resolve = () => tools.resolveForAttempt(userId, [created.id]);
        const first = yield* resolve();
        const updated = yield* tools.update(created.id, created.version, {
          slug: created.slug,
          name: "Catalog",
          description: "Catalog functions.",
          build: build("two"),
        });
        const second = yield* resolve();
        // A save against the version the editor no longer holds is refused.
        const stale = yield* tools
          .update(created.id, created.version, {
            slug: created.slug,
            name: "Catalog",
            description: "",
            build: build("three"),
          })
          .pipe(Effect.flip);
        yield* tools.setEnabled(created.id, false);
        const afterDisable = yield* resolve();
        yield* tools.setEnabled(created.id, true);
        yield* tools.remove(created.id);
        const afterDelete = yield* resolve();
        // A real delete also gives its identifier back to a new module.
        const replacement = yield* tools.create({
          slug: created.slug,
          name: "Replacement",
          description: "",
          createdBy: userId,
          build: build("replacement", created.slug),
        });
        const listed = yield* tools.list();
        return {
          first,
          second,
          updatedVersion: updated.version,
          createdVersion: created.version,
          stale,
          afterDisable,
          afterDelete,
          replacementId: replacement.id,
          stillListed: listed.some((row) => row.id === created.id),
        };
      }),
    );

    expect(result.first).toMatchObject([{ compiled: "compiled one" }]);
    expect(result.second).toMatchObject([{ compiled: "compiled two" }]);
    expect(result.updatedVersion).not.toBe(result.createdVersion);
    expect(result.stale).toMatchObject({ _tag: "CustomToolConflict" });
    expect(result.afterDisable).toEqual([]);
    expect(result.afterDelete).toEqual([]);
    expect(result.replacementId).toEqual(expect.any(String));
    expect(result.stillListed).toBe(false);
  });

  it("renames a module in place and frees the identifier it gave up", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tools = yield* CustomToolRepo;
        const agents = yield* AgentRepo;
        const admin = yield* makeUser("admin");
        const first = `before_${admin.slice(-8)}`;
        const second = `after_${admin.slice(-8)}`;
        const created = yield* tools.create({
          slug: first,
          name: "Catalog",
          description: "Catalog functions.",
          createdBy: admin,
          build: build("one"),
        });
        // The agent attaches the module id, so a rename must not disturb it.
        const agentId = yield* agents.create(admin, {
          ...EMPTY_AGENT_DRAFT,
          name: "Catalog agent",
          customToolIds: [created.id],
        });
        const renamed = yield* tools.update(created.id, created.version, {
          slug: second,
          name: "Catalog",
          description: "Catalog functions.",
          build: build("two", second),
        });
        const resolved = yield* tools.resolveForAttempt(admin, [created.id]);
        // The identifier it gave up is free for a different module.
        const reused = yield* tools.create({
          slug: first,
          name: "Reuse",
          description: "",
          createdBy: admin,
          build: build("one"),
        });
        // Renaming onto a slug another module holds is refused, and refusing
        // must leave the module it refused untouched.
        const collision = yield* tools
          .update(created.id, renamed.version, {
            slug: first,
            name: "Catalog",
            description: "",
            build: build("three"),
          })
          .pipe(Effect.flip);
        const afterCollision = yield* tools.get(created.id);
        const attached = yield* agents.get(admin, agentId);
        return {
          sameId: renamed.id === created.id,
          renamedSlug: renamed.slug,
          resolved,
          reusedId: reused.id,
          collision,
          afterCollisionSlug: afterCollision?.slug,
          attachedIds: attached?.customToolIds,
        };
      }),
    );

    expect(result.sameId).toBe(true);
    expect(result.renamedSlug).toMatch(/^after_/);
    // The rebuilt manifest names the functions under the new identifier.
    expect(result.resolved).toMatchObject([{ compiled: "compiled two" }]);
    expect(result.resolved[0]!.slug).toMatch(/^after_/);
    expect(result.resolved[0]!.functions[0]!.modelName).toMatch(/^custom_after_.*__lookup$/);
    expect(result.reusedId).toEqual(expect.any(String));
    expect(result.collision).toMatchObject({ _tag: "CustomToolSlugTaken" });
    expect(result.afterCollisionSlug).toMatch(/^after_/);
    expect(result.attachedIds).toEqual([result.resolved[0]!.toolId]);
  });

  it("survives its creating admin being deleted", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const tools = yield* CustomToolRepo;
        const authorId = yield* makeUser("admin");
        const survivingAdminId = yield* makeUser("admin");
        const created = yield* tools.create({
          slug: `orphan_${authorId.slice(-8)}`,
          name: "Orphan",
          description: "Outlives its author.",
          createdBy: authorId,
          build: build("one"),
        });
        yield* db.delete(user).where(eq(user.id, authorId));
        const stored = yield* tools.get(created.id);
        const resolved = yield* tools.resolveForAttempt(survivingAdminId, [created.id]);
        const deletedAuthorAccess = yield* tools.resolveForAttempt(authorId, [created.id]);
        return { stored, resolved, deletedAuthorAccess };
      }),
    );

    expect(result.stored).toMatchObject({ createdBy: null, compiled: "compiled one" });
    expect(result.resolved).toMatchObject([{ compiled: "compiled one" }]);
    expect(result.deletedAuthorAccess).toEqual([]);
  });
});

describe("sharing a person's own MCP server", () => {
  it("is out of reach even for an admin, since grants on it mean nothing", async () => {
    const failure = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const sharing = yield* SharingService;
        const admin = yield* makeUser("admin");
        const owner = yield* makeUser();
        const integrationId = uuidv7();
        yield* db.insert(integrationConfigs).values({
          id: integrationId,
          kind: "mcp",
          name: integrationId,
          ownerUserId: owner,
        });
        return yield* sharing
          .change(
            admin,
            { kind: "integration", id: integrationId },
            { action: "publish", audience: "instance" },
          )
          .pipe(Effect.flip);
      }),
    );
    expect(failure._tag).toBe("SharedResourceNotAvailable");
  });
});

describe("custom tool access", () => {
  it("gates attach and every attempt on the sender's grants, with admins exempt", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tools = yield* CustomToolRepo;
        const agents = yield* AgentRepo;
        const groupRepo = yield* GroupRepo;
        const sharing = yield* SharingService;
        const admin = yield* makeUser("admin");
        const member = yield* makeUser();
        const outsider = yield* makeUser();
        const group = yield* groupRepo.createGroup(`ops-${member.slice(-8)}`);
        yield* groupRepo.addMember(group.id, member);
        const created = yield* tools.create({
          slug: `private_${member.slice(-8)}`,
          name: "Private",
          description: "",
          createdBy: admin,
          build: build("one"),
        });
        const share = (change: Parameters<SharingService["Service"]["change"]>[2]) =>
          sharing.change(admin, { kind: "customTool", id: created.id }, change);
        yield* share({ action: "publish", audience: "private" });
        yield* share({ action: "group", groupId: group.id });
        const settings = {
          ...EMPTY_AGENT_DRAFT,
          name: "Ops agent",
          customToolIds: [created.id],
        };
        const memberAgent = yield* agents.create(member, settings);
        const outsiderAttach = yield* agents.create(outsider, settings).pipe(Effect.flip);
        const ids = [created.id];
        const inPlainChat = (userId: string) =>
          tools
            .resolveForAttempt(userId, "all")
            .pipe(Effect.map((rows) => rows.some((row) => row.toolId === created.id)));
        const before = {
          member: (yield* tools.resolveForAttempt(member, ids)).length,
          outsider: (yield* tools.resolveForAttempt(outsider, ids)).length,
          admin: (yield* tools.resolveForAttempt(admin, ids)).length,
          // Plain chat, no agent: the same rule decides the offer.
          plainChatMember: yield* inPlainChat(member),
          plainChatOutsider: yield* inPlainChat(outsider),
          listedForOutsider: (yield* tools.listUsableBy(outsider)).some(
            (row) => row.id === created.id,
          ),
          listedForMember: (yield* tools.listUsableBy(member)).some((row) => row.id === created.id),
        };
        // The agent still exists once its owner leaves the group; the tool
        // simply stops being offered on their attempts.
        yield* groupRepo.removeMember(group.id, member);
        const afterLeaving = (yield* tools.resolveForAttempt(member, ids)).length;
        // A direct grant works the same way as a group.
        yield* share({ action: "email", email: `${outsider}@t.io` });
        const outsiderGranted = (yield* tools.resolveForAttempt(outsider, ids)).length;
        return { memberAgent, outsiderAttach, before, afterLeaving, outsiderGranted };
      }),
    );

    expect(result.memberAgent).toEqual(expect.any(String));
    expect(result.outsiderAttach).toMatchObject({
      reason: "a selected custom tool is unavailable",
    });
    expect(result.before).toEqual({
      member: 1,
      outsider: 0,
      admin: 1,
      plainChatMember: true,
      plainChatOutsider: false,
      listedForOutsider: false,
      listedForMember: true,
    });
    expect(result.afterLeaving).toBe(0);
    expect(result.outsiderGranted).toBe(1);
  });
});
