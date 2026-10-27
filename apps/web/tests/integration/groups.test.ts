import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Effect, ManagedRuntime, Stream } from "effect";
import { uuidv7 } from "uuidv7";
import { Response as AiResponse } from "effect/ai";
import {
  conversations,
  modelGroupAccess,
  models,
  providers,
  userApprovals,
} from "~/db/schema/index.ts";
import { ALL_CAPABILITIES } from "~/modules/groups/policy.ts";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { ChatService } from "~/modules/chat/server/service.ts";
import { GroupRepo } from "~/modules/groups/server/repo.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { AiGateway } from "~/modules/providers/server/gateway.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { constraintViolation, createTestDatabase, type TestDatabase } from "./database.ts";
import { engineLayer } from "./engine-harness.ts";

process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

let database: TestDatabase;
type Services = ChatRepo | ChatService | GroupRepo | ProviderRepo | SyncBus | Db;
let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>;
let providerId: string;

// Denials happen during validation, before any stream starts; the one
// positive send still forks a generation, so the stream must finish cleanly.
const fakeGeneratedText = (text: string) =>
  Effect.succeed({
    text,
    usage: new AiResponse.Usage({
      inputTokens: {
        uncached: undefined,
        total: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    }),
    finishMetadata: undefined,
  });

const gateway = {
  generateText: () => fakeGeneratedText("A title"),
  streamChat: () =>
    Stream.make(
      AiResponse.makePart("text-delta", { id: "t", delta: "ok" }),
      AiResponse.makePart("finish", {
        reason: "stop",
        usage: new AiResponse.Usage({ inputTokens: {}, outputTokens: {} }),
      }),
    ),
} satisfies Partial<AiGateway["Service"]>;

beforeAll(async () => {
  database = await createTestDatabase();
  const url = database.url;

  runtime = ManagedRuntime.make(engineLayer(url, { gateway }));

  providerId = uuidv7();
  await runtime.runPromise(
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

const makeUser = Effect.fn("test.makeUser")(function* (role: "user" | "admin" = "user") {
  const db = yield* Db;
  const userId = uuidv7();
  yield* db.execute(
    `insert into "user" (id, name, email, role)
     values ('${userId}', 'Test', '${userId}@t.io', '${role}')` as never,
  );
  yield* db.insert(userApprovals).values({ userId, status: "approved" });
  return userId;
});

const makeModel = Effect.fn("test.makeModel")(function* (
  options: { access?: "public" | "groups"; enabled?: boolean; providerId?: string } = {},
) {
  const db = yield* Db;
  const id = uuidv7();
  yield* db.insert(models).values({
    id,
    providerId: options.providerId ?? providerId,
    modelKey: `key-${id}`,
    displayName: `Model ${id.slice(-4)}`,
    type: "chat",
    access: options.access ?? "public",
    enabled: options.enabled ?? true,
  });
  return id;
});

const makeProvider = Effect.fn("test.makeProvider")(function* (enabled: boolean) {
  const db = yield* Db;
  const id = uuidv7();
  yield* db.insert(providers).values({
    id,
    name: `Prov ${id.slice(-4)}`,
    preset: "openrouter",
    baseUrl: "http://x",
    apiKeyCiphertext: "x",
    enabled,
  });
  return id;
});

const visibleIds = Effect.fn("test.visibleIds")(function* (userId: string) {
  const repo = yield* ProviderRepo;
  const rows = yield* repo.listChatModelsFor(userId);
  return rows.map((row) => row.id);
});

describe("group management", () => {
  it("defaults sharing off, scopes updates, preserves duplicate adds and resets re-adds", async () => {
    const none = { agents: false, knowledge: false, skills: false, projects: false };
    const skillsOnly = { agents: false, knowledge: false, skills: true, projects: false };
    await run(
      Effect.gen(function* () {
        const repo = yield* GroupRepo;
        const userId = yield* makeUser();
        const other = yield* makeUser("admin");
        const group = yield* repo.createGroup(`Permissions ${uuidv7()}`);
        const second = yield* repo.createGroup(`Isolated ${uuidv7()}`);
        yield* repo.addMember(group.id, userId);
        yield* repo.addMember(group.id, other);
        yield* repo.addMember(second.id, userId);
        const sharingOf = (groupId: string, member: string) =>
          repo
            .listMembers(groupId)
            .pipe(Effect.map((rows) => rows.find((m) => m.userId === member)?.sharing));
        expect(yield* sharingOf(group.id, userId)).toEqual(none);
        expect(yield* sharingOf(group.id, other)).toEqual(none);
        // Each kind is stored on its own, and a duplicate add keeps it.
        yield* repo.setMemberSharing(group.id, userId, skillsOnly);
        yield* repo.addMember(group.id, userId);
        expect(yield* sharingOf(group.id, userId)).toEqual(skillsOnly);
        expect(yield* sharingOf(group.id, other)).toEqual(none);
        expect(yield* sharingOf(second.id, userId)).toEqual(none);
        yield* repo.setMemberSharing(group.id, userId, none);
        expect(yield* sharingOf(group.id, userId)).toEqual(none);
        yield* repo.setMemberSharing(group.id, userId, skillsOnly);
        yield* repo.removeMember(group.id, userId);
        expect(
          yield* repo.setMemberSharing(group.id, userId, skillsOnly).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "GroupMemberNotFound",
          groupId: group.id,
          userId,
        });
        expect(
          yield* repo.setMemberSharing(uuidv7(), userId, skillsOnly).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "GroupMemberNotFound",
          userId,
        });
        expect(yield* sharingOf(group.id, userId)).toBeUndefined();
        yield* repo.addMember(group.id, userId);
        expect(yield* sharingOf(group.id, userId)).toEqual(none);
      }),
    );
  });

  it("creates, renames and lists groups with live member counts", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* GroupRepo;
        const userA = yield* makeUser();
        const userB = yield* makeUser();
        const group = yield* repo.createGroup(`Count ${uuidv7()}`);
        yield* repo.addMember(group.id, userA);
        yield* repo.addMember(group.id, userB);
        yield* repo.renameGroup(group.id, `Renamed ${uuidv7()}`);
        const listed = (yield* repo.listGroups()).find((g) => g.id === group.id);
        return { listed, renamed: listed?.name.startsWith("Renamed") };
      }),
    );
    expect(result.renamed).toBe(true);
    expect(result.listed?.memberCount).toBe(2);
  });

  it("rejects a duplicate name with a domain error, not a crash", async () => {
    const name = `Taken ${uuidv7()}`;
    const error = await run(
      Effect.gen(function* () {
        const repo = yield* GroupRepo;
        yield* repo.createGroup(name);
        return yield* repo.createGroup(name).pipe(Effect.flip);
      }),
    );
    expect(error).toMatchObject({ _tag: "GroupNameTaken", name });
  });

  it("treats re-adding an existing member as a no-op", async () => {
    const count = await run(
      Effect.gen(function* () {
        const repo = yield* GroupRepo;
        const userId = yield* makeUser();
        const group = yield* repo.createGroup(`Idem ${uuidv7()}`);
        yield* repo.addMember(group.id, userId);
        yield* repo.addMember(group.id, userId);
        return (yield* repo.listMembers(group.id)).length;
      }),
    );
    expect(count).toBe(1);
  });

  it("lets one user belong to several groups at once", async () => {
    const memberships = await run(
      Effect.gen(function* () {
        const repo = yield* GroupRepo;
        const userId = yield* makeUser();
        const one = yield* repo.createGroup(`Multi A ${uuidv7()}`);
        const two = yield* repo.createGroup(`Multi B ${uuidv7()}`);
        yield* repo.addMember(one.id, userId);
        yield* repo.addMember(two.id, userId);
        return (yield* repo.listMemberships()).filter((m) => m.userId === userId);
      }),
    );
    expect(memberships).toHaveLength(2);
    expect(new Set(memberships.map((m) => m.groupName)).size).toBe(2);
  });
});

describe("model visibility", () => {
  it("creates complete model settings and private group links together", async () => {
    const result = await run(
      Effect.gen(function* () {
        const groupRepo = yield* GroupRepo;
        const providerRepo = yield* ProviderRepo;
        const group = yield* groupRepo.createGroup(`Create settings ${uuidv7()}`);
        const model = yield* providerRepo.createModel({
          providerId,
          modelKey: `embedding-${uuidv7()}`,
          displayName: "Created embedding",
          type: "embedding",
          contextLength: 8192,
          embeddingDimensions: 1536,
          capabilities: {
            imageOutput: false,
            reasoning: false,
            tools: false,
            vision: true,
            files: false,
          },
          pricing: { input: 0.02, output: null },
          enabled: false,
          access: "groups",
          groupIds: [group.id],
        });
        return {
          model,
          groupId: group.id,
          access: (yield* providerRepo.listModelAccess()).filter((row) => row.modelId === model.id),
        };
      }),
    );

    expect(result.model).toMatchObject({
      displayName: "Created embedding",
      type: "embedding",
      contextLength: 8192,
      embeddingDimensions: 1536,
      capabilities: {
        imageOutput: false,
        reasoning: false,
        tools: false,
        vision: true,
        files: false,
      },
      pricing: { input: 0.02, output: null },
      enabled: false,
      access: "groups",
    });
    expect(result.access).toEqual([{ modelId: result.model.id, groupId: result.groupId }]);
  });

  it("rolls back model creation when a private group does not exist", async () => {
    const modelKey = `rollback-${uuidv7()}`;
    await expect(
      run(
        ProviderRepo.use((repo) =>
          repo.createModel({
            providerId,
            modelKey,
            displayName: "Never persisted",
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
            access: "groups",
            groupIds: [uuidv7()],
          }),
        ),
      ),
    ).rejects.toMatchObject(constraintViolation("model_group_access_group_id_groups_id_fkey"));

    const rows = await run(
      Db.use((db) =>
        db.select({ id: models.id }).from(models).where(eq(models.modelKey, modelKey)),
      ),
    );
    expect(rows).toEqual([]);
  });

  it("updates model settings and private group links together", async () => {
    const result = await run(
      Effect.gen(function* () {
        const groupRepo = yield* GroupRepo;
        const providerRepo = yield* ProviderRepo;
        const modelId = yield* makeModel();
        const group = yield* groupRepo.createGroup(`Settings ${uuidv7()}`);

        yield* providerRepo.updateModel(modelId, {
          displayName: "Edited model",
          type: "chat",
          contextLength: 200_000,
          embeddingDimensions: null,
          capabilities: {
            imageOutput: false,
            reasoning: true,
            tools: true,
            vision: false,
            files: true,
          },
          pricing: { input: 3, output: 12 },
          enabled: false,
          access: "groups",
          groupIds: [group.id],
        });

        return {
          modelId,
          groupId: group.id,
          model: yield* providerRepo.getModel(modelId),
          access: (yield* providerRepo.listModelAccess()).filter((row) => row.modelId === modelId),
        };
      }),
    );

    expect(result.model).toMatchObject({
      displayName: "Edited model",
      type: "chat",
      contextLength: 200_000,
      capabilities: {
        imageOutput: false,
        reasoning: true,
        tools: true,
        vision: false,
        files: true,
      },
      pricing: { input: 3, output: 12 },
      enabled: false,
      access: "groups",
    });
    expect(result.access).toEqual([{ modelId: result.modelId, groupId: result.groupId }]);
  });

  it("shows public models to everyone and private ones to members only", async () => {
    const result = await run(
      Effect.gen(function* () {
        const groupRepo = yield* GroupRepo;
        const providerRepo = yield* ProviderRepo;
        const member = yield* makeUser();
        const outsider = yield* makeUser();
        const group = yield* groupRepo.createGroup(`Vis ${uuidv7()}`);
        yield* groupRepo.addMember(group.id, member);

        const publicModel = yield* makeModel();
        const privateModel = yield* makeModel({ access: "groups" });
        yield* providerRepo.updateModelAccess(privateModel, "groups", [group.id]);

        return {
          publicModel,
          privateModel,
          memberSees: yield* visibleIds(member),
          outsiderSees: yield* visibleIds(outsider),
        };
      }),
    );
    expect(result.memberSees).toContain(result.publicModel);
    expect(result.memberSees).toContain(result.privateModel);
    expect(result.outsiderSees).toContain(result.publicModel);
    expect(result.outsiderSees).not.toContain(result.privateModel);
  });

  it("hides a private model with no groups from everyone but admins", async () => {
    const result = await run(
      Effect.gen(function* () {
        const regular = yield* makeUser();
        const admin = yield* makeUser("admin");
        const staged = yield* makeModel({ access: "groups" });
        return {
          staged,
          regularSees: yield* visibleIds(regular),
          adminSees: yield* visibleIds(admin),
        };
      }),
    );
    expect(result.regularSees).not.toContain(result.staged);
    expect(result.adminSees).toContain(result.staged);
  });

  it("never lists a disabled model, membership or not", async () => {
    const result = await run(
      Effect.gen(function* () {
        const groupRepo = yield* GroupRepo;
        const providerRepo = yield* ProviderRepo;
        const member = yield* makeUser();
        const group = yield* groupRepo.createGroup(`Off ${uuidv7()}`);
        yield* groupRepo.addMember(group.id, member);
        const dark = yield* makeModel({ access: "groups", enabled: false });
        yield* providerRepo.updateModelAccess(dark, "groups", [group.id]);
        const lit = yield* makeModel();
        return {
          dark,
          sees: yield* visibleIds(member),
          // Checking agrees with listing: disabled is unusable, and a chat
          // model is not an image model.
          darkUsable: (yield* providerRepo.usableModel(member, dark, "chat")) !== null,
          litAsChat: (yield* providerRepo.usableModel(member, lit, "chat")) !== null,
          litAsImage: (yield* providerRepo.usableModel(member, lit, "image")) !== null,
        };
      }),
    );
    expect(result.sees).not.toContain(result.dark);
    expect(result).toMatchObject({ darkUsable: false, litAsChat: true, litAsImage: false });
  });

  it("hides every model of a disabled provider, even from admins, until it is re-enabled", async () => {
    const result = await run(
      Effect.gen(function* () {
        const providerRepo = yield* ProviderRepo;
        const userId = yield* makeUser();
        const admin = yield* makeUser("admin");
        const offProvider = yield* makeProvider(false);
        const model = yield* makeModel({ providerId: offProvider });

        const whileOff = {
          userSees: (yield* visibleIds(userId)).includes(model),
          adminSees: (yield* visibleIds(admin)).includes(model),
          userMayUse: (yield* providerRepo.usableModel(userId, model, "chat")) !== null,
          adminMayUse: (yield* providerRepo.usableModel(admin, model, "chat")) !== null,
        };
        yield* providerRepo.updateProvider(offProvider, { enabled: true });
        const afterOn = {
          userSees: (yield* visibleIds(userId)).includes(model),
          userMayUse: (yield* providerRepo.usableModel(userId, model, "chat")) !== null,
        };
        return { whileOff, afterOn };
      }),
    );
    expect(result.whileOff).toEqual({
      userSees: false,
      adminSees: false,
      userMayUse: false,
      adminMayUse: false,
    });
    expect(result.afterOn).toEqual({ userSees: true, userMayUse: true });
  });

  it("agrees with usableModel across the whole matrix", async () => {
    const result = await run(
      Effect.gen(function* () {
        const groupRepo = yield* GroupRepo;
        const providerRepo = yield* ProviderRepo;
        const member = yield* makeUser();
        const outsider = yield* makeUser();
        const admin = yield* makeUser("admin");
        const group = yield* groupRepo.createGroup(`Matrix ${uuidv7()}`);
        yield* groupRepo.addMember(group.id, member);
        const publicModel = yield* makeModel();
        const privateModel = yield* makeModel({ access: "groups" });
        yield* providerRepo.updateModelAccess(privateModel, "groups", [group.id]);

        return {
          memberPublic: (yield* providerRepo.usableModel(member, publicModel, "chat")) !== null,
          memberPrivate: (yield* providerRepo.usableModel(member, privateModel, "chat")) !== null,
          outsiderPrivate:
            (yield* providerRepo.usableModel(outsider, privateModel, "chat")) !== null,
          adminPrivate: (yield* providerRepo.usableModel(admin, privateModel, "chat")) !== null,
          missing: (yield* providerRepo.usableModel(member, uuidv7(), "chat")) !== null,
        };
      }),
    );
    expect(result).toEqual({
      memberPublic: true,
      memberPrivate: true,
      outsiderPrivate: false,
      adminPrivate: true,
      missing: false,
    });
  });

  it("revokes access when the sharing group is deleted", async () => {
    const result = await run(
      Effect.gen(function* () {
        const groupRepo = yield* GroupRepo;
        const providerRepo = yield* ProviderRepo;
        const db = yield* Db;
        const member = yield* makeUser();
        const group = yield* groupRepo.createGroup(`Gone ${uuidv7()}`);
        yield* groupRepo.addMember(group.id, member);
        const privateModel = yield* makeModel({ access: "groups" });
        yield* providerRepo.updateModelAccess(privateModel, "groups", [group.id]);

        const before = (yield* providerRepo.usableModel(member, privateModel, "chat")) !== null;
        yield* groupRepo.deleteGroup(group.id);
        const after = (yield* providerRepo.usableModel(member, privateModel, "chat")) !== null;
        const links = yield* db
          .select()
          .from(modelGroupAccess)
          .where(eq(modelGroupAccess.modelId, privateModel));
        return { before, after, links: links.length };
      }),
    );
    expect(result).toEqual({ before: true, after: false, links: 0 });
  });
});

describe("generation-time enforcement", () => {
  it("rejects forbidden search before creating a turn", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const groups = yield* GroupRepo;
        const chat = yield* ChatService;
        const userId = yield* makeUser();
        const group = yield* groups.createGroup(`No search ${uuidv7()}`);
        yield* groups.addMember(group.id, userId);
        yield* groups.updateGroupCapabilities(group.id, { ...ALL_CAPABILITIES, webSearch: false });
        const conversationId = uuidv7();
        const denied = yield* chat
          .sendMessage({
            userId,
            conversation: { kind: "new", id: conversationId },
            modelId: yield* makeModel(),
            content: "Look this up",
            searchEnabled: true,
            researchEnabled: false,
            attachmentIds: [],
          })
          .pipe(Effect.flip);
        const rows = yield* db
          .select({ id: conversations.id })
          .from(conversations)
          .where(eq(conversations.id, conversationId));
        return { denied, rows };
      }),
    );
    expect(result.denied).toMatchObject({
      _tag: "ToolUnavailable",
      tool: "web_search",
      reason: "not permitted",
    });
    expect(result.rows).toEqual([]);
  });

  it("lets a member send with the shared model, and denies the outsider identically to a missing model", async () => {
    const result = await run(
      Effect.gen(function* () {
        const groupRepo = yield* GroupRepo;
        const providerRepo = yield* ProviderRepo;
        const chat = yield* ChatService;
        const member = yield* makeUser();
        const outsider = yield* makeUser();
        const group = yield* groupRepo.createGroup(`Send ${uuidv7()}`);
        yield* groupRepo.addMember(group.id, member);
        const privateModel = yield* makeModel({ access: "groups" });
        yield* providerRepo.updateModelAccess(privateModel, "groups", [group.id]);

        const sent = yield* chat.sendMessage({
          userId: member,
          conversation: { kind: "new", id: uuidv7() },
          modelId: privateModel,
          content: "hello",
          searchEnabled: false,
          researchEnabled: false,
          attachmentIds: [],
        });
        const denied = yield* chat
          .sendMessage({
            userId: outsider,
            conversation: { kind: "new", id: uuidv7() },
            modelId: privateModel,
            content: "hello",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
          })
          .pipe(Effect.flip);
        return { sentConversation: sent.conversationId, denied };
      }),
    );
    expect(result.sentConversation).toBeTruthy();
    expect(result.denied).toMatchObject({ _tag: "ModelNotFound" });
  });

  it("stops 'retry same' once the member's group access is revoked", async () => {
    const result = await run(
      Effect.gen(function* () {
        const groupRepo = yield* GroupRepo;
        const providerRepo = yield* ProviderRepo;
        const chatRepo = yield* ChatRepo;
        const chat = yield* ChatService;
        const member = yield* makeUser();
        const group = yield* groupRepo.createGroup(`Revoke ${uuidv7()}`);
        yield* groupRepo.addMember(group.id, member);
        const privateModel = yield* makeModel({ access: "groups" });
        yield* providerRepo.updateModelAccess(privateModel, "groups", [group.id]);

        // A finished turn written directly. No generation needed to retry.
        const conversation = yield* chatRepo.createConversation({
          userId: member,
          modelId: privateModel,
        });
        yield* chatRepo.insertMessage({
          conversationId: conversation.id,
          role: "user",
          content: "question",
          status: "complete",
        });
        const assistant = yield* chatRepo.insertMessage({
          conversationId: conversation.id,
          role: "assistant",
          content: "answer",
          status: "complete",
          modelId: privateModel,
        });
        yield* groupRepo.removeMember(group.id, member);

        return yield* chat
          .retryMessage({
            userId: member,
            conversationId: conversation.id,
            messageId: assistant.id,
          })
          .pipe(Effect.flip);
      }),
    );
    expect(result).toMatchObject({ _tag: "ModelNotFound" });
  });
});
