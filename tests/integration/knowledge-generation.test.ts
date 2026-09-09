import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import { PgClient } from "@effect/sql-pg";
import { Deferred, Effect, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { Response, type Prompt } from "effect/unstable/ai";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SkillService } from "~/modules/skills/server/service.ts";
import { SkillRepo } from "~/modules/skills/server/repo.ts";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { AgentService } from "~/modules/agents/server/service.ts";
import { AnalyticsRepo } from "~/modules/analytics/server/repo.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { ChatService } from "~/modules/chat/server/service.ts";
import { StreamEngine } from "~/modules/chat/server/streaming.ts";
import { GroupRepo } from "~/modules/groups/server/repo.ts";
import { EmbeddingSpace } from "~/modules/knowledge/server/embedding-space.ts";
import { KnowledgeIndexer } from "~/modules/knowledge/server/indexer.ts";
import { KnowledgeRepo } from "~/modules/knowledge/server/repo.ts";
import { KnowledgeSearch } from "~/modules/knowledge/server/search.ts";
import { KnowledgeService } from "~/modules/knowledge/server/service.ts";
import { AiGateway, type ChatStreamPart } from "~/modules/providers/server/gateway.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { ToolsRepo } from "~/modules/tools/server/repo.ts";
import { SearchBackend } from "~/modules/tools/server/search.ts";
import { UrlReaderExecutor } from "~/modules/tools/server/url-reader.ts";
import { WebSearchExecutor } from "~/modules/tools/server/web-search.ts";
import { Db } from "~/server/db.ts";
import { makeFakeMemoryService } from "./fake-memory.ts";
import { POSTGRES_IMAGE } from "./postgres-image.ts";
import { FakeDocumentParser } from "./unused-services.ts";

process.env.PROVIDER_KEY_SECRET ??= Buffer.alloc(32, 9).toString("base64");

type GatewayInput = Parameters<AiGateway["Service"]["streamChat"]>[0];
const requests: GatewayInput[] = [];
const finish = (reason = "stop") =>
  Response.makePart("finish", {
    reason: reason as "stop",
    usage: new Response.Usage({
      inputTokens: { total: 100, uncached: 100, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 10, text: 10, reasoning: 0 },
    }),
  }) as ChatStreamPart;
const text = (delta: string) =>
  Response.makePart("text-delta", { id: "text", delta }) as ChatStreamPart;
const tool = (input: GatewayInput, name: string, params: unknown) => {
  const id = uuidv7();
  const result = Stream.unwrap(input.toolkit!.handle(name, params, id).pipe(Effect.orDie)).pipe(
    Stream.orDie,
    Stream.map(
      (value) =>
        Response.toolResultPart({ id, name, providerExecuted: false, ...value }) as ChatStreamPart,
    ),
  ) as Stream.Stream<ChatStreamPart>;
  return Stream.make(
    Response.makePart("tool-call", { id, name, params, providerExecuted: false }) as ChatStreamPart,
  ).pipe(Stream.concat(result), Stream.concat(Stream.make(finish("tool-calls"))));
};
/** The scripted model: what it does with the tools it is offered. */
let script: (input: GatewayInput, calls: number) => Stream.Stream<ChatStreamPart> = () =>
  Stream.make(text("answer"), finish());
let hold: { reached: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | null = null;
const FakeGateway = Layer.succeed(AiGateway, {
  fetchCatalog: () => Effect.succeed([]),
  probeEmbeddingDimensions: () => Effect.die("no dimension probes in these tests"),
  embed: () => Effect.die("unexpected embed call"),
  generateText: () =>
    Effect.succeed({
      text: "Title",
      usage: new Response.Usage({
        inputTokens: { total: 10, uncached: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 2, text: 2, reasoning: 0 },
      }),
    } as never),
  streamChat: (input: GatewayInput) =>
    Stream.suspend(() => {
      requests.push(input);
      const gate = hold;
      const parts = script(input, requests.length);
      return gate
        ? Stream.fromEffect(
            Deferred.succeed(gate.reached, undefined).pipe(
              Effect.andThen(Deferred.await(gate.release)),
            ),
          ).pipe(Stream.flatMap(() => parts))
        : parts;
    }),
} as never);

// Research requires enabled search and reader tools; the backend returns one
// evidence hit so workers have a web source beside the knowledge ones.
const FakeSearchBackend = Layer.succeed(SearchBackend, {
  kind: "fake",
  search: () =>
    Effect.succeed([
      { url: "https://evidence.example/source", title: "Evidence", snippet: "A web finding" },
    ]),
  test: () => Effect.succeed({ resultCount: 1 }),
});
const FakeReader = Layer.succeed(UrlReaderExecutor, {
  availability: () => Effect.succeed({ configured: true, enabled: true }),
  handler: () =>
    Effect.succeed(() =>
      Effect.succeed({
        ok: true,
        targets: [],
        resultCount: 0,
        pagesFetched: 0,
        results: [],
        failures: [],
      }),
    ),
});

const blobs = new Map<string, Uint8Array>();
const MemoryBlobStore = Layer.succeed(BlobStore, {
  put: (key: string, bytes: Uint8Array) => Effect.sync(() => void blobs.set(key, bytes)),
  get: (key: string) => Effect.succeed(blobs.get(key) ?? new Uint8Array()),
  delete: (key: string) => Effect.sync(() => void blobs.delete(key)),
  exists: (key: string) => Effect.succeed(blobs.has(key)),
  deletePrefix: () => Effect.void,
} as never);

let container: StartedPostgreSqlContainer;
type Services =
  | Db
  | ChatRepo
  | ChatService
  | StreamEngine
  | AgentService
  | SkillService
  | AgentRepo
  | KnowledgeRepo
  | KnowledgeIndexer
  | KnowledgeService
  | ProviderRepo
  | ToolsRepo;
let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>;
const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect);
const exec = async (statement: string) =>
  (await run(Effect.flatMap(Db, (db) => db.execute(statement as never)))) as unknown as {
    rows: ReadonlyArray<Record<string, unknown>>;
  };
const createUser = async () => {
  const id = uuidv7();
  await exec(
    `insert into "user" (id, name, email, role) values ('${id}', 'U', '${id}@t.io', 'user')`,
  );
  return id;
};
let smallModelId: string;
let noToolModelId: string;
let researchModelId: string;
const drainIndexer = () =>
  run(
    Effect.gen(function* () {
      const indexer = yield* KnowledgeIndexer;
      for (let step = 0; step < 50; step++) if (!(yield* indexer.runExtraction())) break;
    }),
  );
const settle = async (messageId: string) => {
  await expect
    .poll(
      async () =>
        (await exec(`select status from messages where id = '${messageId}'`)).rows[0]?.status,
      { timeout: 10_000, interval: 25 },
    )
    .not.toBe("streaming");
  return (await exec(`select status, content, error from messages where id = '${messageId}'`))
    .rows[0]!;
};
const promptText = (prompt: Prompt.Prompt) =>
  prompt.content.map((message) => JSON.stringify(message)).join("\n");
const collectionWith = async (owner: string, notes: ReadonlyArray<[string, string]>) => {
  const collectionId = await run(
    Effect.flatMap(KnowledgeService, (service) =>
      service.create(owner, { name: "Notes", description: "" }),
    ),
  );
  const documents = [];
  for (const [title, content] of notes)
    documents.push(
      await run(
        Effect.flatMap(KnowledgeService, (service) =>
          service.addNote(owner, { collectionId, title, content }),
        ),
      ),
    );
  await drainIndexer();
  return { collectionId, documents };
};
const send = (input: {
  userId: string;
  conversationId?: string | null;
  modelId?: string;
  content?: string;
  agentId?: string | null;
  collectionIds?: ReadonlyArray<string>;
  skillIds?: ReadonlyArray<string>;
  searchEnabled?: boolean;
  generationMode?: "chat" | "research";
}) =>
  run(
    Effect.flatMap(ChatService, (chat) =>
      chat.sendMessage({
        userId: input.userId,
        conversationId: input.conversationId ?? null,
        modelId: input.modelId ?? smallModelId,
        content: input.content ?? "Summarize the notes.",
        searchEnabled: input.searchEnabled ?? false,
        attachmentIds: [],
        ...(input.generationMode ? { generationMode: input.generationMode } : {}),
        ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
        collectionIds: input.collectionIds ?? [],
        skillIds: input.skillIds ?? [],
      }),
    ),
  );
const toolCalls = async (messageId: string) =>
  (
    await exec(
      `select id, tool_name, status, result from message_tool_calls where message_id = '${messageId}' order by turn_index, call_index`,
    )
  ).rows;
const configRow = async (messageId: string) =>
  (
    await exec(
      `select agent_id, resolved_agent, standalone_collection_ids, knowledge_mode, search_enabled, collection_ids, plan_enabled from message_generation_config where message_id = '${messageId}'`,
    )
  ).rows[0];

const agentSettings = (collectionIds: string[] = [], revision = 1) => ({
  name: `Agent ${revision}`,
  description: "",
  icon: "book" as const,
  instructions: `Private instructions revision ${revision}.`,
  modelId: null,
  searchEnabled: false,
  planEnabled: revision > 1,
  starters: [],
  collectionIds,
});
const makeAgent = (owner: string, collectionIds: string[] = []) =>
  run(
    Effect.flatMap(AgentService, (service) => service.create(owner, agentSettings(collectionIds))),
  );
const editAgent = (owner: string, agentId: string, collectionIds: string[] = [], revision = 2) =>
  run(
    Effect.flatMap(AgentService, (service) =>
      service.update(owner, {
        ...agentSettings(collectionIds, revision),
        agentId,
        expectedRevision: revision - 1,
      }),
    ),
  );
const retry = (userId: string, conversationId: string, messageId: string) =>
  Effect.flatMap(ChatService, (chat) => chat.retryMessage({ userId, conversationId, messageId }));

beforeAll(async () => {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const url = container.getConnectionUri();
  execSync("pnpm drizzle-kit migrate", {
    cwd: new URL("../..", import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  const PgLive = PgClient.layer({ url: Redacted.make(url), maxConnections: 8 });
  const InfraLayer = Layer.mergeAll(Db.layer, KeyCipher.layer).pipe(Layer.provideMerge(PgLive));
  const ReposLayer = Layer.mergeAll(
    SkillRepo.layer,
    AnalyticsRepo.layer,
    AgentRepo.layer,
    ChatRepo.layer,
    GroupRepo.layer,
    KnowledgeRepo.layer,
    ProviderRepo.layer,
    ToolsRepo.layer,
  ).pipe(Layer.provideMerge(AttachmentRepo.layer), Layer.provideMerge(InfraLayer));
  const CoreLayer = Layer.mergeAll(
    FakeGateway,
    SyncBus.layer,
    WebSearchExecutor.layer.pipe(Layer.provide(FakeSearchBackend)),
    FakeReader,
    MemoryBlobStore,
    FakeDocumentParser,
    makeFakeMemoryService({ autoSave: true }),
  ).pipe(Layer.provideMerge(ReposLayer));
  const KnowledgeLayer = Layer.mergeAll(
    SkillService.layer,
    KnowledgeIndexer.layer,
    KnowledgeSearch.layer,
    KnowledgeService.layer,
    AgentService.layer,
  ).pipe(
    Layer.provideMerge(EmbeddingSpace.layer),
    Layer.provideMerge(AttachmentService.layer),
    Layer.provideMerge(CoreLayer),
  );
  const AppLayer = ChatService.layer.pipe(
    Layer.provideMerge(StreamEngine.layer.pipe(Layer.provideMerge(KnowledgeLayer))),
  );
  runtime = ManagedRuntime.make(AppLayer);

  await run(
    ToolsRepo.use((tools) => tools.updateTool("web_search", { enabled: true, config: {} })),
  );
  const providerId = uuidv7();
  smallModelId = uuidv7();
  noToolModelId = uuidv7();
  researchModelId = uuidv7();
  await exec(
    `insert into providers (id, name, kind, base_url, api_key_ciphertext)
     values ('${providerId}', 'P', 'openai-compatible', 'http://x', 'x')`,
  );
  // A small window: two short notes fit directly, a long one forces retrieval.
  await exec(
    `insert into models (id, provider_id, model_key, display_name, type, context_length, capabilities)
     values ('${smallModelId}', '${providerId}', 'small', 'Small', 'chat', 16000, '{"tools": true, "vision": false, "files": false}'),
            ('${noToolModelId}', '${providerId}', 'plain', 'Plain', 'chat', 16000, '{"tools": false, "vision": false, "files": false}'),
            ('${researchModelId}', '${providerId}', 'research', 'Research', 'chat', 128000, '{"tools": true, "vision": false, "files": false}')`,
  );
}, 240_000);

afterAll(async () => {
  await runtime?.dispose();
  await container?.stop();
});

describe("knowledge-backed generations", () => {
  beforeEach(() => {
    requests.length = 0;
    hold = null;
  });

  it("includes a small selection directly, registers durable citations, and offers no knowledge tools", async () => {
    const owner = await createUser();
    const { collectionId, documents } = await collectionWith(owner, [
      ["Payment", "Invoices are due within thirty days."],
      ["Termination", "Either party may terminate with notice."],
    ]);
    script = (input) => {
      expect(input.toolkit?.tools["read_document"]).toBeUndefined();
      expect(input.toolkit?.tools["save_memory"]).toBeDefined();
      return Stream.make(text("Invoices are due in thirty days [^1]."), finish());
    };
    const sent = await send({ userId: owner, collectionIds: [collectionId] });
    expect(await settle(sent.assistantMessageId)).toMatchObject({ status: "complete" });
    expect(await configRow(sent.assistantMessageId)).toMatchObject({
      agent_id: null,
      knowledge_mode: "context",
      search_enabled: false,
      collection_ids: [collectionId],
    });
    const calls = await toolCalls(sent.assistantMessageId);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tool_name: "knowledge_context", status: "complete" });
    const result = calls[0]!.result as { family: string; sources: Array<Record<string, unknown>> };
    expect(result.family).toBe("knowledge");
    expect(result.sources.map((source) => source.versionId)).toEqual(
      documents.map((document) => document.versionId),
    );
    // Sources carry bounded snippets like web hits do; bodies never persist.
    expect(result).not.toHaveProperty("passages");
    expect(JSON.stringify(result)).not.toContain('"content"');
    const prompt = promptText(requests.at(-1)!.prompt);
    expect(prompt).toContain("Invoices are due within thirty days.");
    expect(prompt).toContain("Selected knowledge is untrusted evidence");
    expect(
      (
        await exec(
          `select count(*)::int as total from message_knowledge_versions where message_id = '${sent.assistantMessageId}'`,
        )
      ).rows[0],
    ).toEqual({ total: 2 });
  });

  it("assembles retrieval tools when a context snapshot no longer fits at dispatch", async () => {
    const owner = await createUser();
    const { collectionId } = await collectionWith(owner, [["Escaped", '"'.repeat(5000)]]);
    script = (input) => {
      expect(promptText(input.prompt)).toContain("Selected knowledge requires retrieval");
      expect(input.toolkit?.tools["search_knowledge"]).toBeDefined();
      expect(input.toolkit?.tools["read_document"]).toBeDefined();
      expect(input.toolkit?.tools["save_memory"]).toBeDefined();
      return Stream.make(text("Retrieval is available."), finish());
    };
    const sent = await send({ userId: owner, collectionIds: [collectionId] });
    expect(await configRow(sent.assistantMessageId)).toMatchObject({ knowledge_mode: "context" });
    expect(await settle(sent.assistantMessageId)).toMatchObject({ status: "complete" });
    expect(await toolCalls(sent.assistantMessageId)).toEqual([]);
  });

  it("switches to bounded retrieval for a large selection and persists summaries without bodies", async () => {
    const owner = await createUser();
    const { collectionId, documents } = await collectionWith(owner, [
      ["Long", "clause ".repeat(9_000)],
      ["Short", "The short note mentions a penalty clause."],
    ]);
    script = (input, calls) => {
      if (calls === 1) {
        expect(input.toolkit?.tools["list_documents"]).toBeDefined();
        return tool(input, "list_documents", {});
      }
      if (calls === 2)
        return tool(input, "read_document", {
          documents: [
            {
              documentId: documents[1]!.documentId,
              versionId: documents[1]!.versionId,
              startOffset: 0,
              maxChars: 200,
            },
          ],
        });
      expect(input.toolkit).toBeDefined();
      return Stream.make(text("The short note mentions a penalty [^1]."), finish());
    };
    const sent = await send({ userId: owner, collectionIds: [collectionId] });
    expect(await settle(sent.assistantMessageId)).toMatchObject({ status: "complete" });
    expect(await configRow(sent.assistantMessageId)).toMatchObject({ knowledge_mode: "retrieval" });
    const calls = await toolCalls(sent.assistantMessageId);
    expect(calls.map((call) => call.tool_name)).toEqual(["list_documents", "read_document"]);
    expect(calls.every((call) => call.status === "complete")).toBe(true);
    const read = calls[1]!.result as {
      family: string;
      summary: Record<string, unknown>;
      sources: Array<Record<string, unknown>>;
    };
    expect(read.family).toBe("knowledge");
    expect(read.summary.passagesReturned).toBe(1);
    expect(read.sources[0]).toMatchObject({ versionId: documents[1]!.versionId, read: true });
    const persisted = JSON.stringify(calls);
    expect(persisted).not.toContain('"passages"');
    expect(persisted).not.toContain('"documents"');
    expect(persisted).not.toContain("clause clause");
    expect(promptText(requests.at(-1)!.prompt)).toContain("Knowledge operations remaining");
    expect(promptText(requests[requests.length - 3]!.prompt)).not.toContain("clause clause");
  });

  it("offers retrieval for an oversized selection on a model without native tool calling", async () => {
    const owner = await createUser();
    const { collectionId } = await collectionWith(owner, [["Long", "clause ".repeat(9_000)]]);
    // The gateway polyfills tool calling for such a model, so the turn is
    // written and dispatched with the retrieval toolkit like any other.
    script = (input) => {
      expect(promptText(input.prompt)).toContain("Selected knowledge requires retrieval");
      expect(input.toolkit?.tools["search_knowledge"]).toBeDefined();
      return Stream.make(text("Retrieval is available."), finish());
    };
    const sent = await send({
      userId: owner,
      modelId: noToolModelId,
      collectionIds: [collectionId],
    });
    expect(await settle(sent.assistantMessageId)).toMatchObject({
      status: "complete",
      content: "Retrieval is available.",
    });
    expect(await configRow(sent.assistantMessageId)).toMatchObject({
      knowledge_mode: "retrieval",
      collection_ids: [collectionId],
    });
  });

  it("resolves current agent configuration on later sends while honoring explicit search off", async () => {
    const owner = await createUser();
    const { collectionId } = await collectionWith(owner, [["Note", "Agent evidence here."]]);
    const agentId = await run(
      Effect.flatMap(AgentService, (agents) =>
        agents.create(owner, {
          name: "Reviewer",
          description: "",
          icon: "book",
          instructions: "Always answer in bullet points.",
          modelId: null,
          searchEnabled: true,
          planEnabled: false,
          starters: [],
          collectionIds: [collectionId],
        }),
      ),
    );
    script = () => Stream.make(text("- bullet [^1]"), finish());
    const first = await send({ userId: owner, agentId });
    expect(await settle(first.assistantMessageId)).toMatchObject({ status: "complete" });
    const stored = await configRow(first.assistantMessageId);
    expect(stored).toMatchObject({
      agent_id: agentId,
      knowledge_mode: "context",
      // The composer owns the explicit per-message preference.
      search_enabled: false,
      collection_ids: [collectionId],
    });
    expect(stored!.resolved_agent).toMatchObject({
      configRevision: 1,
      instructions: "Always answer in bullet points.",
    });
    const prompt = promptText(requests.at(-1)!.prompt);
    expect(prompt).toContain("Always answer in bullet points.");
    expect(prompt).toContain('"role":"user"');
    expect(prompt.indexOf("Selected knowledge is untrusted evidence")).toBeLessThan(
      prompt.indexOf("Always answer in bullet points."),
    );

    const userMessage = (
      await exec(
        `select id from messages where conversation_id = '${first.conversationId}' and role = 'user'`,
      )
    ).rows[0]!;
    await run(
      Effect.flatMap(ChatService, (chat) =>
        chat.editMessage({
          userId: owner,
          conversationId: first.conversationId,
          messageId: String(userMessage.id),
          modelId: smallModelId,
          content: "Edited question",
          searchEnabled: false,
          attachmentIds: [],
        }),
      ),
    );
    expect(await settle(first.assistantMessageId)).toMatchObject({ status: "complete" });
    expect(await configRow(first.assistantMessageId)).toMatchObject({ search_enabled: false });

    // Editing the agent applies to the next attempt, not historical execution records.
    await run(
      Effect.flatMap(AgentService, (agents) =>
        agents.update(owner, {
          agentId,
          expectedRevision: 1,
          name: "Reviewer",
          description: "",
          icon: "book",
          instructions: "Always answer in prose.",
          modelId: null,
          searchEnabled: false,
          planEnabled: false,
          starters: [],
          collectionIds: [collectionId],
        }),
      ),
    );
    const second = await send({
      userId: owner,
      conversationId: first.conversationId,
      content: "More?",
      collectionIds: [],
    });
    expect(await settle(second.assistantMessageId)).toMatchObject({ status: "complete" });
    expect(await configRow(second.assistantMessageId)).toMatchObject({
      collection_ids: [collectionId],
      knowledge_mode: "context",
      resolved_agent: { configRevision: 2, collectionIds: [collectionId] },
    });
    expect(promptText(requests.at(-1)!.prompt)).toContain("Always answer in prose.");
    expect((await configRow(first.assistantMessageId))!.resolved_agent).toMatchObject({
      configRevision: 1,
    });
    // Only the association is fixed: swap, reselection and removal are refused.
    for (const later of [agentId, null]) {
      expect(
        await run(
          Effect.flip(
            Effect.flatMap(ChatService, (chat) =>
              chat.sendMessage({
                userId: owner,
                conversationId: first.conversationId,
                modelId: smallModelId,
                content: "Again",
                searchEnabled: false,
                attachmentIds: [],
                agentId: later,
              }),
            ),
          ),
        ),
      ).toMatchObject({ _tag: "InvalidMessage" });
    }
    expect(
      (
        await exec(
          `select count(*)::int as n from messages where conversation_id = '${first.conversationId}'`,
        )
      ).rows[0],
    ).toEqual({ n: 4 });
  });

  it.each(["send", "retry", "edit", "edit-without-answer"] as const)(
    "resolves current instructions and dependencies for %s, preserving standalone overlap and current versions",
    async (action) => {
      const owner = await createUser();
      const old = await collectionWith(owner, [["Old", "Old dependency."]]);
      const overlap = await collectionWith(owner, [["Overlap", "Old version."]]);
      const added = await collectionWith(owner, [["New", "New dependency."]]);
      const agentId = await makeAgent(owner, [old.collectionId, overlap.collectionId]);
      const first = await send({ userId: owner, agentId, collectionIds: [overlap.collectionId] });
      await settle(first.assistantMessageId);
      const previous = await configRow(first.assistantMessageId);
      expect(previous!.standalone_collection_ids).toEqual([overlap.collectionId]);
      await editAgent(owner, agentId, [added.collectionId]);
      const replacement = await run(
        Effect.flatMap(KnowledgeService, (service) =>
          service.replaceNote(owner, {
            collectionId: overlap.collectionId,
            documentId: overlap.documents[0]!.documentId,
            title: "Overlap",
            content: "Current replacement version.",
          }),
        ),
      );
      await drainIndexer();
      let messageId = first.assistantMessageId;
      if (action === "send") {
        const next = await send({
          userId: owner,
          conversationId: first.conversationId,
          collectionIds: [overlap.collectionId],
        });
        messageId = next.assistantMessageId;
      } else if (action === "retry") await run(retry(owner, first.conversationId, messageId));
      else {
        const userMessage = (
          await exec(
            `select id from messages where conversation_id = '${first.conversationId}' and role = 'user'`,
          )
        ).rows[0]!;
        if (action === "edit-without-answer")
          await exec(`delete from messages where id = '${messageId}'`);
        const edited = await run(
          Effect.flatMap(ChatService, (chat) =>
            chat.editMessage({
              userId: owner,
              conversationId: first.conversationId,
              messageId: String(userMessage.id),
              modelId: noToolModelId,
              content: "Edited question",
              searchEnabled: false,
              attachmentIds: [],
            }),
          ),
        );
        messageId = edited.assistantMessageId;
      }
      expect(await settle(messageId)).toMatchObject({ status: "complete" });
      const config = await configRow(messageId);
      expect(config).toMatchObject({
        resolved_agent: { configRevision: 2, instructions: "Private instructions revision 2." },
        plan_enabled: true,
        search_enabled: false,
        collection_ids:
          action === "edit-without-answer"
            ? [added.collectionId]
            : [added.collectionId, overlap.collectionId],
        standalone_collection_ids: action === "edit-without-answer" ? [] : [overlap.collectionId],
      });
      const versions = (
        await exec(
          `select version_id from message_knowledge_versions where message_id = '${messageId}'`,
        )
      ).rows;
      if (action !== "edit-without-answer")
        expect(versions).toContainEqual({ version_id: replacement.versionId });
      expect(versions).not.toContainEqual({ version_id: old.documents[0]!.versionId });
      expect(promptText(requests.at(-1)!.prompt)).toContain("Private instructions revision 2.");
      if (action === "send") expect(await configRow(first.assistantMessageId)).toEqual(previous);
    },
  );

  it.each([1, 2, 3, 4])(
    "captures one coherent revision when a send races an owner edit (race %s)",
    async () => {
      const owner = await createUser();
      const before = await collectionWith(owner, [["Before", "Before."]]);
      const after = await collectionWith(owner, [["After", "After."]]);
      const agentId = await makeAgent(owner, [before.collectionId]);
      const [sent] = await Promise.all([
        send({ userId: owner, agentId }),
        editAgent(owner, agentId, [after.collectionId]),
      ]);
      await settle(sent.assistantMessageId);
      const config = await configRow(sent.assistantMessageId);
      const revision = (config!.resolved_agent as { configRevision: number }).configRevision;
      expect([1, 2]).toContain(revision);
      expect(config).toMatchObject({
        resolved_agent: {
          configRevision: revision,
          instructions: `Private instructions revision ${revision}.`,
        },
        collection_ids: [revision === 1 ? before.collectionId : after.collectionId],
        plan_enabled: revision === 2,
      });
    },
  );

  it("keeps explicit model/search choices across agent default edits and retries", async () => {
    const owner = await createUser();
    const agentId = await makeAgent(owner);
    const first = await send({
      userId: owner,
      agentId,
      modelId: noToolModelId,
      searchEnabled: true,
    });
    await settle(first.assistantMessageId);
    await run(
      Effect.flatMap(AgentService, (service) =>
        service.update(owner, {
          ...agentSettings([], 2),
          agentId,
          expectedRevision: 1,
          modelId: researchModelId,
          searchEnabled: false,
        }),
      ),
    );
    await run(retry(owner, first.conversationId, first.assistantMessageId));
    await settle(first.assistantMessageId);
    expect(await configRow(first.assistantMessageId)).toMatchObject({
      search_enabled: true,
      resolved_agent: { configRevision: 2 },
    });
    expect(
      (await exec(`select model_id from messages where id = '${first.assistantMessageId}'`)).rows,
    ).toEqual([{ model_id: noToolModelId }]);
    const userMessage = (
      await exec(
        `select id from messages where conversation_id = '${first.conversationId}' and role = 'user'`,
      )
    ).rows[0]!;
    await run(
      Effect.flatMap(ChatService, (chat) =>
        chat.editMessage({
          userId: owner,
          conversationId: first.conversationId,
          messageId: String(userMessage.id),
          modelId: smallModelId,
          searchEnabled: false,
          content: "Explicit edit",
          attachmentIds: [],
        }),
      ),
    );
    await settle(first.assistantMessageId);
    expect(await configRow(first.assistantMessageId)).toMatchObject({ search_enabled: false });
    expect(
      (await exec(`select model_id from messages where id = '${first.assistantMessageId}'`)).rows,
    ).toEqual([{ model_id: smallModelId }]);
  });

  it("keeps a running attempt coherent while an edit changes the next attempt", async () => {
    const owner = await createUser();
    const firstCollection = await collectionWith(owner, [["Before", "Original evidence."]]);
    const secondCollection = await collectionWith(owner, [["After", "Updated evidence."]]);
    const agentId = await makeAgent(owner, [firstCollection.collectionId]);
    hold = { reached: await run(Deferred.make<void>()), release: await run(Deferred.make<void>()) };
    const first = await send({ userId: owner, agentId });
    await run(Deferred.await(hold.reached));
    await editAgent(owner, agentId, [secondCollection.collectionId]);
    expect(await configRow(first.assistantMessageId)).toMatchObject({
      resolved_agent: { configRevision: 1, collectionIds: [firstCollection.collectionId] },
    });
    await run(Deferred.succeed(hold.release, undefined));
    hold = null;
    expect(await settle(first.assistantMessageId)).toMatchObject({ status: "complete" });
    expect(promptText(requests[0]!.prompt)).toContain("Private instructions revision 1.");
    const next = await send({ userId: owner, conversationId: first.conversationId });
    await settle(next.assistantMessageId);
    expect(await configRow(next.assistantMessageId)).toMatchObject({
      resolved_agent: { configRevision: 2, collectionIds: [secondCollection.collectionId] },
    });
  });

  it.each(
    (["delete", "unshare", "dependency"] as const).flatMap((change) =>
      (["chat", "research"] as const).map((generationMode) => ({ change, generationMode })),
    ),
  )(
    "fails closed on $change before a $generationMode answer, attachments, descendants or run state can be destroyed",
    async ({ change, generationMode }) => {
      const owner = await createUser();
      const recipient = await createUser();
      const agentId = await makeAgent(owner);
      await exec(
        `insert into agent_user_grants (agent_id,user_id) values ('${agentId}','${recipient}')`,
      );
      if (generationMode === "research")
        script = (input) =>
          tool(input, "ask_user", {
            questions: [{ question: "Focus?", options: [], multiSelect: false }],
          });
      const first = await send({
        userId: recipient,
        agentId,
        generationMode,
        modelId: researchModelId,
      });
      await settle(first.assistantMessageId);
      const later = await send({ userId: recipient, conversationId: first.conversationId });
      await settle(later.assistantMessageId);
      if (change === "delete")
        await run(Effect.flatMap(AgentRepo, (repo) => repo.remove(owner, agentId)));
      else if (change === "unshare")
        await exec(`delete from agent_user_grants where agent_id = '${agentId}'`);
      else {
        const hidden = await collectionWith(owner, [["Hidden", "Private dependency."]]);
        await editAgent(owner, agentId, [hidden.collectionId]);
      }
      const before = (
        await exec(
          `select * from messages where conversation_id = '${first.conversationId}' order by id`,
        )
      ).rows;
      const blobId = uuidv7();
      const attachmentId = uuidv7();
      blobs.set(blobId, new Uint8Array([1, 2, 3]));
      await exec(
        `insert into attachment_blobs (id,user_id,sha256,storage_key,size,media_type) values ('${blobId}','${recipient}','${blobId}','${blobId}',3,'image/png')`,
      );
      await exec(
        `insert into attachments (id,user_id,blob_id,file_name) values ('${attachmentId}','${recipient}','${blobId}','answer.png')`,
      );
      await exec(
        `insert into message_attachments (message_id,attachment_id,position) values ('${first.assistantMessageId}','${attachmentId}',0)`,
      );
      const readRuns = async () =>
        (
          await exec(
            `select * from research_runs where conversation_id = '${first.conversationId}' order by id`,
          )
        ).rows;
      const runs = await readRuns();
      const config = await configRow(first.assistantMessageId);
      const userMessage = before.find((message) => message.role === "user")!;
      const expected = {
        _tag: change === "dependency" ? "KnowledgeNotAvailable" : "AgentNotAvailable",
      };
      expect(
        await run(Effect.flip(retry(recipient, first.conversationId, first.assistantMessageId))),
      ).toMatchObject(expected);
      expect(
        await run(
          Effect.flip(
            Effect.flatMap(ChatService, (chat) =>
              chat.editMessage({
                userId: recipient,
                conversationId: first.conversationId,
                messageId: String(userMessage.id),
                modelId: researchModelId,
                content: "Should not replace",
                searchEnabled: false,
                attachmentIds: [],
              }),
            ),
          ),
        ),
      ).toMatchObject(expected);
      expect(
        await run(
          Effect.flip(
            Effect.flatMap(ChatService, (chat) =>
              chat.sendMessage({
                userId: recipient,
                conversationId: first.conversationId,
                modelId: smallModelId,
                content: "Should not append",
                searchEnabled: false,
                attachmentIds: [],
              }),
            ),
          ),
        ),
      ).toMatchObject(expected);
      expect(
        (
          await exec(
            `select * from messages where conversation_id = '${first.conversationId}' order by id`,
          )
        ).rows,
      ).toEqual(before);
      expect(await readRuns()).toEqual(runs);
      expect(await configRow(first.assistantMessageId)).toEqual(config);
      expect(
        (
          await exec(
            `select attachment_id from message_attachments where message_id = '${first.assistantMessageId}'`,
          )
        ).rows,
      ).toEqual([{ attachment_id: attachmentId }]);
      expect(blobs.get(blobId)).toEqual(new Uint8Array([1, 2, 3]));
      if (change === "delete")
        expect(
          (
            await exec(
              `select agent_id from conversation_agents where conversation_id = '${first.conversationId}'`,
            )
          ).rows,
        ).toEqual([{ agent_id: null }]);
    },
  );

  it.each(["retry", "edit"] as const)(
    "refreshes research %s configuration with a fresh run and generation fence",
    async (action) => {
      const owner = await createUser();
      const agentId = await makeAgent(owner);
      script = (input) =>
        tool(input, "ask_user", {
          questions: [{ question: "Focus?", options: [], multiSelect: false }],
        });
      const first = await send({
        userId: owner,
        agentId,
        modelId: researchModelId,
        generationMode: "research",
      });
      await settle(first.assistantMessageId);
      const fence = async () =>
        (
          await exec(
            `select research_run_id, generation_id from messages where id = '${first.assistantMessageId}'`,
          )
        ).rows[0]!;
      const original = await fence();
      await editAgent(owner, agentId);
      if (action === "retry")
        await run(retry(owner, first.conversationId, first.assistantMessageId));
      else {
        const question = (
          await exec(
            `select id from messages where conversation_id = '${first.conversationId}' and role = 'user'`,
          )
        ).rows[0]!;
        await run(
          Effect.flatMap(ChatService, (chat) =>
            chat.editMessage({
              userId: owner,
              conversationId: first.conversationId,
              messageId: String(question.id),
              modelId: researchModelId,
              content: "Edited research",
              searchEnabled: false,
              attachmentIds: [],
            }),
          ),
        );
      }
      expect(await settle(first.assistantMessageId)).toMatchObject({ status: "complete" });
      expect(await configRow(first.assistantMessageId)).toMatchObject({
        resolved_agent: { configRevision: 2 },
      });
      const current = await fence();
      expect(current.research_run_id).not.toBe(original.research_run_id);
      expect(current.generation_id).not.toBe(original.generation_id);
    },
  );

  it.each(["chat", "research"] as const)(
    "resolves live configuration for a validated %s continuation",
    async (generationMode) => {
      const owner = await createUser();
      const old = await collectionWith(owner, [["Old", "Old evidence."]]);
      const current = await collectionWith(owner, [["Current", "Current evidence."]]);
      const agentId = await makeAgent(owner, [old.collectionId]);
      script = (input) =>
        tool(input, "ask_user", {
          questions: [{ question: "Which focus?", options: [], multiSelect: false }],
        });
      const first = await send({
        userId: owner,
        agentId,
        generationMode,
        modelId: researchModelId,
      });
      expect(await settle(first.assistantMessageId)).toMatchObject({ status: "complete" });
      const calls = await toolCalls(first.assistantMessageId);
      const call = calls.find((candidate) => candidate.tool_name === "ask_user")!;
      expect(call).toBeDefined();
      await editAgent(owner, agentId, [current.collectionId]);
      script = () => Stream.make(text("continued"), finish());
      const next = await run(
        Effect.flatMap(ChatService, (chat) =>
          chat.sendMessage({
            userId: owner,
            conversationId: first.conversationId,
            modelId: researchModelId,
            searchEnabled: false,
            attachmentIds: [],
            questionResponse: { callId: String(call.id), response: { kind: "skip" } },
          }),
        ),
      );
      await settle(next.assistantMessageId);
      expect(await configRow(next.assistantMessageId)).toMatchObject({
        resolved_agent: { configRevision: 2 },
        collection_ids: [current.collectionId],
        standalone_collection_ids: [],
      });
      expect(
        (await exec(`select generation_mode from messages where id = '${next.assistantMessageId}'`))
          .rows,
      ).toEqual([{ generation_mode: generationMode }]);
    },
  );

  it("branches historical records but resolves future attempts live, including deletion tombstones", async () => {
    const owner = await createUser();
    const agentId = await makeAgent(owner);
    const first = await send({ userId: owner, agentId });
    await settle(first.assistantMessageId);
    await editAgent(owner, agentId);
    const branch = await run(
      Effect.flatMap(ChatService, (chat) =>
        chat.branchConversation({
          userId: owner,
          conversationId: first.conversationId,
          messageId: first.assistantMessageId,
        }),
      ),
    );
    const cloned = (
      await exec(
        `select id from messages where conversation_id = '${branch.conversationId}' and role = 'assistant'`,
      )
    ).rows[0]!;
    expect(await configRow(String(cloned.id))).toEqual(await configRow(first.assistantMessageId));
    const next = await send({ userId: owner, conversationId: branch.conversationId });
    await settle(next.assistantMessageId);
    expect(await configRow(next.assistantMessageId)).toMatchObject({
      resolved_agent: { configRevision: 2 },
    });
    await run(Effect.flatMap(AgentRepo, (repo) => repo.remove(owner, agentId)));
    const tombstone = await run(
      Effect.flatMap(ChatService, (chat) =>
        chat.branchConversation({
          userId: owner,
          conversationId: first.conversationId,
          messageId: first.assistantMessageId,
        }),
      ),
    );
    expect(
      (
        await exec(
          `select agent_id from conversation_agents where conversation_id = '${tombstone.conversationId}'`,
        )
      ).rows,
    ).toEqual([{ agent_id: null }]);
    const tombstoneAnswer = (
      await exec(
        `select id from messages where conversation_id = '${tombstone.conversationId}' and role = 'assistant'`,
      )
    ).rows[0]!;
    expect(
      await run(Effect.flip(retry(owner, tombstone.conversationId, String(tombstoneAnswer.id)))),
    ).toMatchObject({ _tag: "AgentNotAvailable" });
  });

  it.each(["none", "read_url", "web_search"] as const)(
    "preserves enabled search on retry after %s activity",
    async (activity) => {
      const owner = await createUser();
      script = (input, calls) =>
        calls === 1 && activity !== "none"
          ? tool(
              input,
              activity,
              activity === "read_url"
                ? { urls: ["https://evidence.example/source"] }
                : { queries: ["evidence"] },
            )
          : Stream.make(text("first"), finish());
      const sent = await send({
        userId: owner,
        content: "Consider https://evidence.example/source",
        searchEnabled: true,
      });
      expect(await settle(sent.assistantMessageId)).toMatchObject({ status: "complete" });
      expect(await configRow(sent.assistantMessageId)).toMatchObject({ search_enabled: true });
      if (activity !== "none")
        expect((await toolCalls(sent.assistantMessageId)).map((call) => call.tool_name)).toContain(
          activity,
        );
      script = (input) => {
        expect(input.toolkit?.tools["web_search"]).toBeDefined();
        return Stream.make(text("retried"), finish());
      };
      await run(
        Effect.flatMap(ChatService, (chat) =>
          chat.retryMessage({
            userId: owner,
            conversationId: sent.conversationId,
            messageId: sent.assistantMessageId,
          }),
        ),
      );
      expect(await settle(sent.assistantMessageId)).toMatchObject({
        status: "complete",
        content: "retried",
      });
      expect(await configRow(sent.assistantMessageId)).toMatchObject({ search_enabled: true });
    },
  );

  it.each(
    [false, true].flatMap((withAgent) =>
      [false, true].flatMap((searchEnabled) =>
        [false, true].map((available) => ({ withAgent, searchEnabled, available })),
      ),
    ),
  )(
    "retries with saved search=$searchEnabled and availability=$available (agent=$withAgent)",
    async ({ withAgent, searchEnabled, available }) => {
      const owner = await createUser();
      const agentId = withAgent ? await makeAgent(owner) : null;
      script = () => Stream.make(text("first"), finish());
      const sent = await send({ userId: owner, agentId, searchEnabled });
      expect(await settle(sent.assistantMessageId)).toMatchObject({ status: "complete" });
      expect(await configRow(sent.assistantMessageId)).toMatchObject({
        search_enabled: searchEnabled,
      });
      if (agentId)
        await run(
          AgentService.use((service) =>
            service.update(owner, {
              ...agentSettings([], 2),
              agentId,
              expectedRevision: 1,
              searchEnabled: !searchEnabled,
            }),
          ),
        );
      await run(
        ToolsRepo.use((tools) =>
          tools.updateTool("web_search", { enabled: available, config: {} }),
        ),
      );
      try {
        script = (input) => {
          expect(Boolean(input.toolkit?.tools["web_search"])).toBe(searchEnabled && available);
          return Stream.make(text("retried"), finish());
        };
        await run(
          ChatService.use((chat) =>
            chat.retryMessage({
              userId: owner,
              conversationId: sent.conversationId,
              messageId: sent.assistantMessageId,
              modelId: noToolModelId,
            }),
          ),
        );
        expect(await settle(sent.assistantMessageId)).toMatchObject({
          status: "complete",
          content: "retried",
        });
        expect(await configRow(sent.assistantMessageId)).toMatchObject({
          search_enabled: searchEnabled && available,
        });
      } finally {
        await run(
          ToolsRepo.use((tools) => tools.updateTool("web_search", { enabled: true, config: {} })),
        );
      }
    },
  );

  it.each(
    [false, true].flatMap((withAgent) =>
      [false, true].map((searchEnabled) => ({ withAgent, searchEnabled })),
    ),
  )(
    "applies edited search=$searchEnabled instead of the saved choice (agent=$withAgent)",
    async ({ withAgent, searchEnabled }) => {
      const owner = await createUser();
      const agentId = withAgent ? await makeAgent(owner) : null;
      script = () => Stream.make(text("first"), finish());
      const sent = await send({ userId: owner, agentId, searchEnabled: !searchEnabled });
      expect(await settle(sent.assistantMessageId)).toMatchObject({ status: "complete" });
      const userMessage = (
        await exec(
          `select id from messages where conversation_id = '${sent.conversationId}' and role = 'user'`,
        )
      ).rows[0]!;
      script = (input) => {
        expect(Boolean(input.toolkit?.tools["web_search"])).toBe(searchEnabled);
        return Stream.make(text("edited"), finish());
      };
      const edited = await run(
        ChatService.use((chat) =>
          chat.editMessage({
            userId: owner,
            conversationId: sent.conversationId,
            messageId: String(userMessage.id),
            modelId: noToolModelId,
            searchEnabled,
            content: "Updated request",
            attachmentIds: [],
          }),
        ),
      );
      expect(await settle(edited.assistantMessageId)).toMatchObject({
        status: "complete",
        content: "edited",
      });
      expect(await configRow(edited.assistantMessageId)).toMatchObject({
        search_enabled: searchEnabled,
      });
    },
  );

  // Editing a message is how a user fixes the selection they sent it with, so a
  // submitted one replaces the saved standalone set — the same rule `searchEnabled`
  // follows above. Retry has no submission and keeps what was saved.
  it.each([false, true])("applies an edited collection selection (agent=%s)", async (withAgent) => {
    const owner = await createUser();
    const agentId = withAgent ? await makeAgent(owner) : null;
    const first = await collectionWith(owner, [["First", "First dependency."]]);
    const second = await collectionWith(owner, [["Second", "Second dependency."]]);
    script = () => Stream.make(text("first"), finish());
    const sent = await send({ userId: owner, agentId, collectionIds: [first.collectionId] });
    expect(await settle(sent.assistantMessageId)).toMatchObject({ status: "complete" });
    expect(await configRow(sent.assistantMessageId)).toMatchObject({
      standalone_collection_ids: [first.collectionId],
    });
    const userMessage = (
      await exec(
        `select id from messages where conversation_id = '${sent.conversationId}' and role = 'user'`,
      )
    ).rows[0]!;
    script = () => Stream.make(text("edited"), finish());
    const edited = await run(
      ChatService.use((chat) =>
        chat.editMessage({
          userId: owner,
          conversationId: sent.conversationId,
          messageId: String(userMessage.id),
          modelId: smallModelId,
          searchEnabled: false,
          content: "Updated request",
          attachmentIds: [],
          collectionIds: [second.collectionId],
        }),
      ),
    );
    expect(await settle(edited.assistantMessageId)).toMatchObject({ status: "complete" });
    expect(await configRow(edited.assistantMessageId)).toMatchObject({
      standalone_collection_ids: [second.collectionId],
    });
    // The swapped-in collection's documents are the ones the attempt may cite.
    const versions = (
      await exec(
        `select version_id from message_knowledge_versions where message_id = '${edited.assistantMessageId}'`,
      )
    ).rows;
    expect(versions).toContainEqual({ version_id: second.documents[0]!.versionId });
    expect(versions).not.toContainEqual({ version_id: first.documents[0]!.versionId });
  });

  it.each(
    [false, true].flatMap((withAgent) =>
      [false, true].map((searchEnabled) => ({ withAgent, searchEnabled })),
    ),
  )(
    "inherits saved search=$searchEnabled for a structured answer (agent=$withAgent)",
    async ({ withAgent, searchEnabled }) => {
      const owner = await createUser();
      const agentId = withAgent ? await makeAgent(owner) : null;
      script = (input) =>
        tool(input, "ask_user", {
          questions: [{ question: "Which focus?", options: [], multiSelect: false }],
        });
      const sent = await send({ userId: owner, agentId, searchEnabled });
      expect(await settle(sent.assistantMessageId)).toMatchObject({ status: "complete" });
      const call = (await toolCalls(sent.assistantMessageId)).find(
        (activity) => activity.tool_name === "ask_user",
      )!;
      script = (input) => {
        expect(Boolean(input.toolkit?.tools["web_search"])).toBe(searchEnabled);
        return Stream.make(text("continued"), finish());
      };
      const continued = await run(
        ChatService.use((chat) =>
          chat.sendMessage({
            userId: owner,
            conversationId: sent.conversationId,
            modelId: noToolModelId,
            searchEnabled: !searchEnabled,
            attachmentIds: [],
            questionResponse: { callId: String(call.id), response: { kind: "skip" } },
          }),
        ),
      );
      expect(await settle(continued.assistantMessageId)).toMatchObject({
        status: "complete",
        content: "continued",
      });
      expect(await configRow(continued.assistantMessageId)).toMatchObject({
        search_enabled: searchEnabled,
      });
    },
  );

  it("continues a structured question on a model without native tool calling", async () => {
    const owner = await createUser();
    const { collectionId } = await collectionWith(owner, [["Large", "evidence ".repeat(9000)]]);
    script = (input) =>
      tool(input, "ask_user", {
        questions: [{ question: "Which focus?", options: [], multiSelect: false }],
      });
    const sent = await send({ userId: owner, collectionIds: [collectionId] });
    expect(await settle(sent.assistantMessageId)).toMatchObject({ status: "complete" });
    const call = (await toolCalls(sent.assistantMessageId))[0]!;
    const answer = (modelId: string) =>
      Effect.flatMap(ChatService, (chat) =>
        chat.sendMessage({
          userId: owner,
          conversationId: sent.conversationId,
          modelId,
          searchEnabled: false,
          attachmentIds: [],
          collectionIds: [],
          questionResponse: { callId: String(call.id), response: { kind: "skip" } },
        }),
      );
    script = () => Stream.make(text("continued"), finish());
    const continued = await run(answer(noToolModelId));
    expect(await settle(continued.assistantMessageId)).toMatchObject({
      status: "complete",
      content: "continued",
    });
  });

  it("fails an unavailable agent or collection before any row is written", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const { collectionId } = await collectionWith(owner, [["Note", "Private."]]);
    const agentId = await run(
      Effect.flatMap(AgentService, (agents) =>
        agents.create(owner, {
          name: "Private agent",
          description: "",
          icon: "robot",
          instructions: "",
          modelId: null,
          searchEnabled: false,
          planEnabled: false,
          starters: [],
          collectionIds: [collectionId],
        }),
      ),
    );
    // An agent grant is not a grant to its collections.
    await exec(
      `insert into agent_user_grants (agent_id, user_id) values ('${agentId}', '${stranger}')`,
    );
    const sendAs = (input: { agentId?: string; collectionIds?: string[] }) =>
      run(
        Effect.flip(
          Effect.flatMap(ChatService, (chat) =>
            chat.sendMessage({
              userId: stranger,
              conversationId: null,
              modelId: smallModelId,
              content: "Hi",
              searchEnabled: false,
              attachmentIds: [],
              ...input,
            }),
          ),
        ),
      );
    expect(await sendAs({ collectionIds: [collectionId] })).toMatchObject({
      _tag: "KnowledgeNotAvailable",
    });
    expect(await sendAs({ agentId })).toMatchObject({ _tag: "KnowledgeNotAvailable" });
    expect(await sendAs({ agentId: uuidv7() })).toMatchObject({ _tag: "AgentNotAvailable" });
    expect(
      (await exec(`select count(*)::int as total from conversations where user_id = '${stranger}'`))
        .rows[0],
    ).toEqual({ total: 0 });
  });

  it("retries with the saved manifest and fails when access to it is gone", async () => {
    const owner = await createUser();
    const { collectionId, documents } = await collectionWith(owner, [["Note", "Retry evidence."]]);
    script = () => Stream.make(text("first [^1]"), finish());
    const sent = await send({ userId: owner, collectionIds: [collectionId] });
    await settle(sent.assistantMessageId);
    // A document added after the question must not appear on retry.
    await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.addNote(owner, { collectionId, title: "Later", content: "Added later." }),
      ),
    );
    await drainIndexer();
    script = () => Stream.make(text("second [^1]"), finish());
    await run(
      Effect.flatMap(ChatService, (chat) =>
        chat.retryMessage({
          userId: owner,
          conversationId: sent.conversationId,
          messageId: sent.assistantMessageId,
        }),
      ),
    );
    expect(await settle(sent.assistantMessageId)).toMatchObject({
      status: "complete",
      content: "second [^1]",
    });
    const prompt = promptText(requests.at(-1)!.prompt);
    expect(prompt).toContain("Retry evidence.");
    expect(prompt).not.toContain("Added later.");
    const calls = await toolCalls(sent.assistantMessageId);
    expect(calls).toHaveLength(1);
    expect(
      (calls[0]!.result as { sources: Array<{ versionId: string }> }).sources.map(
        (s) => s.versionId,
      ),
    ).toEqual([documents[0]!.versionId]);
    // The new turn sees the current collection, including the later note.
    const next = await send({
      userId: owner,
      conversationId: sent.conversationId,
      content: "And now?",
      collectionIds: [collectionId],
    });
    await settle(next.assistantMessageId);
    expect(promptText(requests.at(-1)!.prompt)).toContain("Added later.");

    await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.removeDocument(owner, documents[0]!.documentId),
      ),
    );
    const failure = await run(
      Effect.flip(
        Effect.flatMap(ChatService, (chat) =>
          chat.retryMessage({
            userId: owner,
            conversationId: sent.conversationId,
            messageId: sent.assistantMessageId,
          }),
        ),
      ),
    );
    expect(failure).toMatchObject({ _tag: "KnowledgeNotAvailable" });
    expect(
      (await exec(`select status from messages where id = '${sent.assistantMessageId}'`)).rows[0],
    ).toEqual({ status: "complete" });
  });

  it("copies configuration and manifests verbatim on branch", async () => {
    const owner = await createUser();
    const { collectionId } = await collectionWith(owner, [["Note", "Branch evidence."]]);
    script = () => Stream.make(text("answer [^1]"), finish());
    const sent = await send({ userId: owner, collectionIds: [collectionId] });
    await settle(sent.assistantMessageId);
    const branch = await run(
      Effect.flatMap(ChatService, (chat) =>
        chat.branchConversation({
          userId: owner,
          conversationId: sent.conversationId,
          messageId: sent.assistantMessageId,
        }),
      ),
    );
    const rows = (
      await exec(
        `select c.knowledge_mode, c.collection_ids, (select count(*)::int from message_knowledge_versions v where v.message_id = c.message_id) as manifest from message_generation_config c join messages m on m.id = c.message_id where m.conversation_id = '${branch.conversationId}'`,
      )
    ).rows;
    expect(rows).toEqual([
      { knowledge_mode: "context", collection_ids: [collectionId], manifest: 1 },
    ]);
    const next = await send({
      userId: owner,
      conversationId: branch.conversationId,
      content: "Continue",
    });
    await settle(next.assistantMessageId);
    expect(await configRow(next.assistantMessageId)).toMatchObject({
      knowledge_mode: "none",
      collection_ids: [],
    });
    expect(promptText(requests.at(-1)!.prompt)).not.toContain("Branch evidence.");
  });

  it("gives research workers the knowledge tools on a shared budget and cites documents in synthesis", async () => {
    const owner = await createUser();
    const { collectionId, documents } = await collectionWith(owner, [
      ["Contract", "The contract fixes a ninety-day notice period."],
    ]);
    const phaseOf = (input: GatewayInput) => {
      const content = promptText(input.prompt);
      if (content.includes("You compact the older part of a chat conversation"))
        return "compaction";
      if (input.toolkit?.tools["ask_user"]) return "clarification";
      if (input.toolkit?.tools["dispatch_research"]) return "coordinator";
      if (input.toolkit?.tools["web_search"]) return "worker";
      if (content.includes("Prepare a self-contained research brief")) return "planning";
      if (content.includes("Write a concise, evidence-dense report")) return "report";
      return "synthesis";
    };
    let coordinatorTurns = 0;
    const workerPrompts: string[] = [];
    script = (input) => {
      const phase = phaseOf(input);
      if (phase === "clarification") return Stream.make(text("No clarification needed."), finish());
      if (phase === "planning")
        return Stream.make(text("Check the contract and the web."), finish());
      if (phase === "coordinator")
        return ++coordinatorTurns === 1
          ? tool(input, "dispatch_research", {
              tasks: [
                { title: "Notice", assignment: "Find the notice period in the selected contract." },
              ],
            })
          : tool(input, "finish_research", {});
      if (phase === "worker") {
        workerPrompts.push(promptText(input.prompt));
        expect(input.toolkit?.tools["read_document"]).toBeDefined();
        expect(input.toolkit?.tools["search_knowledge"]).toBeDefined();
        const rounds = input.prompt.content.filter((message) => message.role === "tool").length;
        if (rounds === 0) return tool(input, "web_search", { queries: ["notice period"] });
        if (rounds === 1)
          return tool(input, "read_document", {
            documents: [
              {
                documentId: documents[0]!.documentId,
                versionId: documents[0]!.versionId,
                startOffset: 0,
                maxChars: 200,
              },
            ],
          });
        return Stream.make(finish());
      }
      if (phase === "report")
        return Stream.make(
          text("The contract fixes ninety days[^2]; the web agrees[^1]."),
          finish(),
        );
      return Stream.make(text("# Findings\nNinety days of notice[^2].\n"), finish());
    };
    const sent = await send({
      userId: owner,
      modelId: researchModelId,
      content: "What notice period applies?",
      collectionIds: [collectionId],
      generationMode: "research",
    });
    const final = await settle(sent.assistantMessageId);
    expect(final).toMatchObject({ status: "complete" });
    expect(final.content).toContain("[^2]");
    expect(await configRow(sent.assistantMessageId)).toMatchObject({ knowledge_mode: "context" });
    const calls = (
      await exec(
        `select tool_name, status, research_task_id is not null as task, result from message_tool_calls where message_id = '${sent.assistantMessageId}' order by turn_index, call_index`,
      )
    ).rows;
    const read = calls.find((call) => call.tool_name === "read_document");
    expect(read).toMatchObject({ status: "complete", task: true });
    const result = read!.result as { family: string; sources: Array<Record<string, unknown>> };
    expect(result.family).toBe("knowledge");
    expect(result.sources[0]).toMatchObject({
      index: 2,
      versionId: documents[0]!.versionId,
      read: true,
    });
    expect(JSON.stringify(calls)).not.toContain('"passages"');
    // Workers see the knowledge policy and budget, but never document bodies in the prefix.
    expect(workerPrompts[0]).toContain("Selected knowledge documents are available");
    expect(workerPrompts[0]).toContain("Knowledge operations remaining (shared)");
    expect(workerPrompts[0]).not.toContain("ninety-day notice period");
    // The root research row exposes the document source to the citation chip.
    const root = calls.find((call) => call.tool_name === "deep_research");
    expect(JSON.stringify(root?.result)).toContain(documents[0]!.versionId);
  });

  it("shares one skill session and budget across research workers without leaking bodies outward", async () => {
    const owner = await createUser();
    const id = await run(
      Effect.flatMap(SkillService, (service) =>
        service.save(owner, {
          files: [
            {
              path: "SKILL.md",
              content:
                "---\nname: review\ndescription: Review carefully\n---\nRESEARCH_ROOT_GUIDANCE",
            },
            { path: "references/depth.md", content: "SUPPORTING_DETAIL for careful review" },
          ],
        }),
      ),
    );
    const phaseOf = (input: GatewayInput) => {
      const content = promptText(input.prompt);
      if (content.includes("You compact the older part of a chat conversation"))
        return "compaction";
      if (input.toolkit?.tools["ask_user"]) return "clarification";
      if (input.toolkit?.tools["dispatch_research"]) return "coordinator";
      if (input.toolkit?.tools["web_search"]) return "worker";
      if (content.includes("Prepare a self-contained research brief")) return "planning";
      if (content.includes("Write a concise, evidence-dense report")) return "report";
      return "synthesis";
    };
    let coordinatorTurns = 0;
    const workerPrompts: string[] = [];
    const remainingSeen: number[] = [];
    script = (input) => {
      const phase = phaseOf(input);
      if (phase === "clarification") return Stream.make(text("No clarification needed."), finish());
      if (phase === "planning") return Stream.make(text("Consult the skill."), finish());
      if (phase === "coordinator")
        return ++coordinatorTurns === 1
          ? tool(input, "dispatch_research", {
              tasks: [
                { title: "First", assignment: "Apply the review guidance." },
                { title: "Second", assignment: "Apply the review guidance again." },
              ],
            })
          : tool(input, "finish_research", {});
      if (phase === "worker") {
        workerPrompts.push(promptText(input.prompt));
        expect(input.toolkit?.tools["read_skill_file"]).toBeDefined();
        const rounds = input.prompt.content.filter((message) => message.role === "tool").length;
        if (rounds === 0)
          return tool(input, "read_skill_file", {
            skillId: id,
            path: "references/depth.md",
            offset: 0,
          });
        return Stream.make(finish());
      }
      if (phase === "report") return Stream.make(text("Report of the review."), finish());
      return Stream.make(text("# Findings\nThe review guidance was applied.\n"), finish());
    };
    const sent = await send({
      userId: owner,
      modelId: researchModelId,
      content: "Review this.",
      skillIds: [id],
      generationMode: "research",
    });
    expect(await settle(sent.assistantMessageId)).toMatchObject({ status: "complete" });
    const calls = (
      await exec(
        `select tool_name, status, research_task_id is not null as task, result from message_tool_calls where message_id = '${sent.assistantMessageId}' order by turn_index, call_index`,
      )
    ).rows;
    const reads = calls.filter((call) => call.tool_name === "read_skill_file");
    expect(reads).toHaveLength(2);
    for (const read of reads) {
      expect(read).toMatchObject({ status: "complete", task: true });
      expect((read.result as { family: string }).family).toBe("skill");
      remainingSeen.push(0);
    }
    // Root instructions reach every worker; file bodies never enter durable rows.
    expect(workerPrompts.every((prompt) => prompt.includes("RESEARCH_ROOT_GUIDANCE"))).toBe(true);
    expect(JSON.stringify(calls)).not.toContain("SUPPORTING_DETAIL");
    expect(JSON.stringify(calls)).not.toContain("RESEARCH_ROOT_GUIDANCE");
    const outer = (
      await exec(`select content from messages where id = '${sent.assistantMessageId}'`)
    ).rows[0]!.content as string;
    expect(outer).not.toContain("SUPPORTING_DETAIL");
  });

  it("offers the checklist only when the agent enables it, keeps the latest list, and starts fresh on retry", async () => {
    const owner = await createUser();
    const plain = await run(
      Effect.flatMap(AgentService, (agents) =>
        agents.create(owner, {
          name: "Planner",
          description: "",
          icon: "robot",
          instructions: "",
          modelId: null,
          searchEnabled: false,
          planEnabled: true,
          starters: [],
          collectionIds: [],
        }),
      ),
    );
    const list = (...values: Array<[string, "pending" | "in_progress" | "completed"]>) => ({
      steps: values.map(([step, status]) => ({ step, status })),
    });
    script = (input, calls) => {
      if (calls === 1) {
        expect(input.toolkit?.tools["update_plan"]).toBeDefined();
        return tool(input, "update_plan", list(["Draft", "in_progress"], ["Review", "pending"]));
      }
      if (calls === 2)
        return tool(input, "update_plan", list(["Draft", "completed"], ["Review", "in_progress"]));
      return Stream.make(text("done"), finish());
    };
    const sent = await send({ userId: owner, agentId: plain, content: "Plan this." });
    expect(await settle(sent.assistantMessageId)).toMatchObject({ status: "complete" });
    expect(await configRow(sent.assistantMessageId)).toMatchObject({ plan_enabled: true });
    const calls = await toolCalls(sent.assistantMessageId);
    expect(calls.map((call) => call.tool_name)).toEqual(["update_plan", "update_plan"]);
    expect(calls[1]!.result).toMatchObject({
      outcome: "updated",
      steps: [
        { step: "Draft", status: "completed" },
        { step: "Review", status: "in_progress" },
      ],
    });
    // The reminder carries the current list only — never a history of revisions.
    const last = promptText(requests.at(-1)!.prompt);
    expect(last).toContain("[x] Draft");
    expect(last).toContain("[~] Review");
    expect(last).toContain("not evidence of completed work");
    expect(last.match(/Current checklist/g)).toHaveLength(1);
    expect(last).not.toContain('"steps"');
    expect(promptText(requests[0]!.prompt)).not.toContain("Current checklist");

    // Retry answers the same question with a clean list.
    let retryPrompts: string[] = [];
    script = (input) => {
      retryPrompts.push(promptText(input.prompt));
      return Stream.make(text("retried"), finish());
    };
    await run(
      Effect.flatMap(ChatService, (chat) =>
        chat.retryMessage({
          userId: owner,
          conversationId: sent.conversationId,
          messageId: sent.assistantMessageId,
        }),
      ),
    );
    expect(await settle(sent.assistantMessageId)).toMatchObject({
      status: "complete",
      content: "retried",
    });
    expect(retryPrompts.every((prompt) => !prompt.includes("Current checklist"))).toBe(true);
    expect(await toolCalls(sent.assistantMessageId)).toEqual([]);

    // An agent without the preference is never offered the tool.
    const quiet = await run(
      Effect.flatMap(AgentService, (agents) =>
        agents.create(owner, {
          name: "Quiet",
          description: "",
          icon: "robot",
          instructions: "",
          modelId: null,
          searchEnabled: false,
          planEnabled: false,
          starters: [],
          collectionIds: [],
        }),
      ),
    );
    script = (input) => {
      expect(input.toolkit?.tools["update_plan"]).toBeUndefined();
      return Stream.make(text("no checklist"), finish());
    };
    const other = await send({ userId: owner, agentId: quiet, content: "And this." });
    expect(await settle(other.assistantMessageId)).toMatchObject({ status: "complete" });
  });

  it.each(["chat", "research"] as const)(
    "terminates %s when the selection is revoked mid-flight",
    async (generationMode) => {
      const owner = await createUser();
      const { collectionId, documents } = await collectionWith(owner, [
        ["Note", "Revoked evidence."],
      ]);
      hold = {
        reached: await run(Deferred.make<void>()),
        release: await run(Deferred.make<void>()),
      };
      script = () => Stream.make(text("late"), finish());
      const sent = await send({
        userId: owner,
        collectionIds: [collectionId],
        generationMode,
        ...(generationMode === "research" ? { modelId: researchModelId } : {}),
      });
      await run(Deferred.await(hold.reached));
      await run(
        Effect.flatMap(KnowledgeService, (service) =>
          service.removeDocument(owner, documents[0]!.documentId),
        ),
      );
      await run(Deferred.succeed(hold.release, undefined));
      hold = null;
      const final = await settle(sent.assistantMessageId);
      // Already-streamed text can remain visible, but revoked evidence must never
      // produce a successfully completed generation, even without another tool call.
      expect(final.status).toBe("error");
      expect(
        await run(
          Effect.flip(
            Effect.flatMap(KnowledgeService, (service) =>
              service.read(owner, { collectionId, ...documents[0]!, startOffset: 0, maxChars: 10 }),
            ),
          ),
        ),
      ).toMatchObject({ _tag: "KnowledgeNotAvailable" });
    },
  );
});

const saveGuidance = (owner: string, body: string, skillId?: string) =>
  run(
    Effect.flatMap(SkillService, (service) =>
      service.save(owner, {
        files: [
          {
            path: "SKILL.md",
            content: `---\nname: review\ndescription: Review carefully\n---\n${body}`,
          },
        ],
        ...(skillId ? { skillId, expectedRevision: 1 } : {}),
      }),
    ),
  );
const skillConfig = async (messageId: string) =>
  (
    await exec(
      `select standalone_skill_ids, skills from message_generation_config where message_id = '${messageId}'`,
    )
  ).rows[0]!;

describe("portable skill generation attempts", () => {
  it("cannot complete successfully when skill access is lost during the last model call", async () => {
    const owner = await createUser();
    const id = await saveGuidance(owner, "Guidance captured before deletion");
    const gate = {
      reached: await run(Deferred.make<void>()),
      release: await run(Deferred.make<void>()),
    };
    hold = gate;
    const first = await send({ userId: owner, skillIds: [id] });
    await run(Deferred.await(gate.reached));
    try {
      await run(Effect.flatMap(SkillService, (service) => service.remove(owner, id)));
    } finally {
      await run(Deferred.succeed(gate.release, undefined));
      hold = null;
    }
    expect(await settle(first.assistantMessageId)).toMatchObject({ status: "error" });
  });

  it("retains an explicit overlap when an agent drops its skill dependency", async () => {
    const owner = await createUser();
    const id = await saveGuidance(owner, "Original overlapping guidance");
    const agentId = await run(
      Effect.flatMap(AgentService, (service) =>
        service.create(owner, { ...agentSettings(), skillIds: [id] }),
      ),
    );
    const first = await send({ userId: owner, agentId, skillIds: [id] });
    expect(await settle(first.assistantMessageId)).toMatchObject({ status: "complete" });
    await editAgent(owner, agentId);
    await saveGuidance(owner, "Current standalone guidance", id);
    await run(retry(owner, first.conversationId, first.assistantMessageId));
    expect(await settle(first.assistantMessageId)).toMatchObject({ status: "complete" });
    expect(await skillConfig(first.assistantMessageId)).toMatchObject({
      standalone_skill_ids: [id],
      skills: [{ skillId: id, explicit: true }],
    });
    const next = await send({ userId: owner, conversationId: first.conversationId });
    expect(await settle(next.assistantMessageId)).toMatchObject({ status: "complete" });
    expect(await skillConfig(next.assistantMessageId)).toMatchObject({
      standalone_skill_ids: [],
      skills: [],
    });
  });

  it.each(["send", "retry", "edit", "branch-retry"] as const)(
    "resolves latest skill instructions for %s without native tool gating",
    async (action) => {
      const owner = await createUser();
      const id = await saveGuidance(owner, "UNIQUE_OLD_GUIDANCE");
      const first = await send({ userId: owner, modelId: noToolModelId, skillIds: [id] });
      expect(await settle(first.assistantMessageId)).toMatchObject({ status: "complete" });
      const old = await skillConfig(first.assistantMessageId);
      expect(
        requests.some((request) => promptText(request.prompt).includes("UNIQUE_OLD_GUIDANCE")),
      ).toBe(true);
      await saveGuidance(owner, "UNIQUE_CURRENT_GUIDANCE", id);
      requests.length = 0;
      let messageId = first.assistantMessageId;
      if (action === "send") {
        messageId = (
          await send({ userId: owner, conversationId: first.conversationId, skillIds: [id] })
        ).assistantMessageId;
      } else if (action === "edit") {
        const question = (
          await exec(
            `select id from messages where conversation_id = '${first.conversationId}' and role = 'user'`,
          )
        ).rows[0]!;
        messageId = (
          await run(
            Effect.flatMap(ChatService, (chat) =>
              chat.editMessage({
                userId: owner,
                conversationId: first.conversationId,
                messageId: String(question.id),
                modelId: noToolModelId,
                content: "Edited skill question",
                searchEnabled: false,
                attachmentIds: [],
              }),
            ),
          )
        ).assistantMessageId;
      } else if (action === "branch-retry") {
        const branch = await run(
          Effect.flatMap(ChatService, (chat) =>
            chat.branchConversation({
              userId: owner,
              conversationId: first.conversationId,
              messageId,
            }),
          ),
        );
        messageId = String(
          (
            await exec(
              `select id from messages where conversation_id = '${branch.conversationId}' and role = 'assistant'`,
            )
          ).rows[0]!.id,
        );
        expect(await skillConfig(messageId)).toEqual(old);
        expect(
          (await exec(`select revision_id from message_skills where message_id = '${messageId}'`))
            .rows,
        ).toHaveLength(1);
        await run(retry(owner, branch.conversationId, messageId));
      } else await run(retry(owner, first.conversationId, messageId));
      expect(await settle(messageId)).toMatchObject({ status: "complete" });
      expect(await skillConfig(messageId)).toMatchObject({ standalone_skill_ids: [id] });
      expect((await skillConfig(messageId)).skills).not.toEqual(old.skills);
      expect(
        requests.some((request) => promptText(request.prompt).includes("UNIQUE_CURRENT_GUIDANCE")),
      ).toBe(true);
      expect(
        requests.every((request) => !promptText(request.prompt).includes("UNIQUE_OLD_GUIDANCE")),
      ).toBe(true);
      expect(JSON.stringify(await toolCalls(messageId))).not.toContain("UNIQUE_CURRENT_GUIDANCE");
    },
  );

  it.each(["retry", "edit"] as const)(
    "preserves answers and descendants when a skill blocks %s",
    async (action) => {
      const owner = await createUser();
      const id = await saveGuidance(owner, "Protected guidance");
      const first = await send({ userId: owner, skillIds: [id] });
      await settle(first.assistantMessageId);
      const next = await send({ userId: owner, conversationId: first.conversationId });
      await settle(next.assistantMessageId);
      const snapshot = async () =>
        (
          await exec(
            `select id, content, status from messages where conversation_id = '${first.conversationId}' order by created_at, id`,
          )
        ).rows;
      const before = await snapshot();
      await run(Effect.flatMap(SkillService, (service) => service.remove(owner, id)));
      const attempt: Effect.Effect<unknown, unknown, ChatService> =
        action === "retry"
          ? retry(owner, first.conversationId, first.assistantMessageId)
          : Effect.flatMap(ChatService, (chat) =>
              chat.editMessage({
                userId: owner,
                conversationId: first.conversationId,
                messageId: String(before[0]!.id),
                modelId: noToolModelId,
                content: "Must not replace the question",
                searchEnabled: false,
                attachmentIds: [],
              }),
            );
      expect(await run(Effect.flip(attempt))).toMatchObject({ _tag: "SkillNotAvailable" });
      expect(await snapshot()).toEqual(before);
    },
  );
});
