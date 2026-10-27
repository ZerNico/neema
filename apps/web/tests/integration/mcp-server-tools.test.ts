import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { and, asc, eq, sql } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { Response as AiResponse } from "effect/ai";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  apiKeys,
  conversations,
  defaultCapabilities,
  documentSteps,
  messageAttachments,
  messages,
  oauthClient,
  user,
} from "~/db/schema/index.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { LanguageRepo } from "~/modules/language/server/repo.ts";
import { ChatService } from "~/modules/chat/server/service.ts";
import { StreamEngine } from "~/modules/chat/server/streaming.ts";
import { KnowledgeSearch } from "~/modules/knowledge/server/search.ts";
import { KnowledgeService } from "~/modules/knowledge/server/service.ts";
import { EmbeddingSpace } from "~/modules/knowledge/server/embedding-space.ts";
import { KnowledgeIndexer } from "~/modules/knowledge/server/indexer.ts";
import { MemoryService } from "~/modules/memory/server/service.ts";
import { SkillService } from "~/modules/skills/server/service.ts";
import type { McpGrant } from "~/modules/auth/server/mcp-access.ts";
import { IntegrationApprovals } from "~/modules/integrations/server/approvals.ts";
import { MAX_API_KEYS } from "~/modules/api-keys/schema.ts";
import type { McpScope } from "~/modules/mcp-server/scopes.ts";
import { ApiKeys } from "~/modules/api-keys/server/service.ts";
import { apiKeysAllowed } from "~/modules/mcp-server/server/access.ts";
import { apiKeyGrant } from "~/modules/mcp-server/server/api-key-grant.ts";
import { ConnectedApps } from "~/modules/mcp-server/server/connected-apps.ts";
import { mcpEndpoint } from "~/modules/mcp-server/server/endpoint.ts";
import type { McpServices } from "~/modules/mcp-server/server/tools/index.ts";
import { ProjectService } from "~/modules/projects/server/service.ts";
import {
  AiGateway,
  ProviderUnreachable,
  type ChatStreamPart,
} from "~/modules/providers/server/gateway.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { Db } from "~/server/db.ts";
import { seedEligibleSession } from "../fixtures/eligible-session.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";
import { engineLayer } from "./engine-harness.ts";
import { memoryBlobStore } from "./unused-services.ts";

process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

const origin = "https://chat.example";
const resource = `${origin}/api/mcp`;

type GatewayInput = Parameters<AiGateway["Service"]["streamChat"]>[0];
const usage = () => new AiResponse.Usage({ inputTokens: {}, outputTokens: {} });
const finish = (reason: "stop" | "tool-calls" = "stop") =>
  AiResponse.makePart("finish", { reason, usage: usage() }) as ChatStreamPart;
const reply = (text: string) =>
  Stream.make(
    AiResponse.makePart("text-delta", { id: "t", delta: text }) as ChatStreamPart,
    finish(),
  );

/** What the fake model answers each round; a test sets it before sending. */
let answer: (input: GatewayInput) => Stream.Stream<ChatStreamPart> = () => reply("An answer.");

/** An answer held until the test lets it go, so a test can act while it runs. */
const heldAnswer = () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  answer = () =>
    Stream.fromEffect(Effect.promise(() => released)).pipe(
      Stream.flatMap(() => reply("Held answer.")),
    );
  return release;
};

/** One round that asks the person a question through the real ask_user tool. */
const askingAnswer = (params: unknown) => (input: GatewayInput) => {
  const toolkit = input.toolkit;
  if (!toolkit) return Stream.die("ask_user was not offered");
  const id = "ask-1";
  const results = Stream.unwrap(
    toolkit.handle("ask_user", params as never, id).pipe(Effect.orDie),
  ).pipe(
    Stream.orDie,
    Stream.map(
      (result) =>
        AiResponse.toolResultPart({
          id,
          name: "ask_user",
          providerExecuted: false,
          ...result,
        }) as ChatStreamPart,
    ),
  ) as Stream.Stream<ChatStreamPart>;
  return Stream.make(
    AiResponse.makePart("tool-call", {
      id,
      name: "ask_user",
      params,
      providerExecuted: false,
    }) as ChatStreamPart,
  ).pipe(Stream.concat(results), Stream.concat(Stream.make(finish("tool-calls"))));
};

const gateway = {
  generateText: () =>
    Effect.succeed({
      text: "A title",
      usage: new AiResponse.Usage({ inputTokens: {}, outputTokens: {} }),
      finishMetadata: undefined,
    }),
  streamChat: (input: GatewayInput) => Stream.suspend(() => answer(input)),
} satisfies Partial<AiGateway["Service"]>;

type Services = McpServices | ChatService | StreamEngine | Db | KnowledgeIndexer | SkillService;
let database: TestDatabase;
let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>;
let providerId: string;

beforeAll(async () => {
  database = await createTestDatabase();
  runtime = ManagedRuntime.make(
    Layer.mergeAll(
      ProjectService.layer,
      ConnectedApps.layer,
      ApiKeys.layer,
      SkillService.layer,
    ).pipe(
      Layer.provideMerge(
        engineLayer(database.url, {
          maxConnections: 8,
          gateway,
          services: Layer.mergeAll(
            // Files sent over MCP are stored, so they need somewhere to go.
            memoryBlobStore(),
            MemoryService.layer,
            // The real registry, over the stub: delegated answers park on it.
            IntegrationApprovals.layer,
            // Approvals put to the app's person are worded in their language.
            LanguageRepo.layer,
          ),
          // The real library: these tools read it as the app's own pages do.
          knowledge: Layer.mergeAll(
            KnowledgeSearch.layer,
            KnowledgeService.layer,
            KnowledgeIndexer.layer,
          ).pipe(Layer.provideMerge(EmbeddingSpace.layer)),
        }),
      ),
    ),
  );
  await run(
    Effect.flatMap(Db, (db) =>
      db.insert(oauthClient).values({
        id: uuidv7(),
        clientId: "client-1",
        name: "Claude",
        redirectUris: ["http://127.0.0.1/cb"],
      }),
    ),
  );
  providerId = uuidv7();
  await run(
    Effect.flatMap(Db, (db) =>
      db.execute(
        `insert into providers (id, name, preset, base_url, api_key_ciphertext)
         values ('${providerId}', 'Prov', 'openrouter', 'http://x', 'x')` as never,
      ),
    ),
  );
}, 180_000);

afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});

const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  runtime.runPromise(effect as never) as Promise<A>;

const makeUser = () =>
  run(
    Effect.gen(function* () {
      const db = yield* Db;
      const id = uuidv7();
      yield* db.insert(user).values({ id, name: "Nico", email: `${id}@t.io` });
      yield* seedEligibleSession(id);
      return id;
    }),
  );

const makeModel = (displayName = `Model ${uuidv7().slice(-4)}`) =>
  run(
    Effect.flatMap(ProviderRepo, (providers) =>
      providers.createModel({
        providerId,
        modelKey: `key-${uuidv7()}`,
        displayName,
        type: "chat",
        contextLength: null,
        embeddingDimensions: null,
        capabilities: {
          imageOutput: false,
          reasoning: false,
          tools: true,
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

/** A real MCP client against the endpoint, holding a grant with these scopes. */
type Elicit = (params: {
  message: string;
  requestedSchema?: unknown;
}) => Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }>;

const connect = async (
  userId: string,
  scopes: ReadonlyArray<string>,
  options: {
    elicit?: Elicit;
    era?: "auto" | "legacy";
    /** A real bearer and how the gate reads it, in place of the fixed grant. */
    bearer?: { token: string; grantFor: (token: string) => Promise<McpGrant | null> };
  } = {},
) => {
  const grant: McpGrant = {
    userId,
    clientId: "client-1",
    scopes,
    audience: [resource],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
  const serve = mcpEndpoint({
    resource,
    grantFor: options.bearer?.grantFor ?? (async (token) => (token === "token" ? grant : null)),
    allowed: async () => true,
    run: (effect, signal) => runtime.runPromise(effect, { signal }),
    stateKey: new Uint8Array(32).fill(1),
  });
  const client = new Client(
    { name: "test", version: "1.0.0" },
    {
      versionNegotiation: { mode: options.era ?? "auto" },
      ...(options.elicit ? { capabilities: { elicitation: { form: {} } } } : {}),
    },
  );
  if (options.elicit) {
    const elicit = options.elicit;
    client.setRequestHandler(
      "elicitation/create",
      async (request) => (await elicit(request.params as never)) as never,
    );
  }
  await client.connect(
    new StreamableHTTPClientTransport(new URL(resource), {
      fetch: (input, init) => serve(new Request(input, init)),
      requestInit: {
        headers: { authorization: `Bearer ${options.bearer?.token ?? "token"}` },
      },
    }),
  );
  return client;
};

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const response = await client.callTool({ name, arguments: args });
  return response as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content: Array<{ text?: string }>;
  };
};

describe("MCP tools", () => {
  it("lists only the tools the grant's scopes allow", async () => {
    const userId = await makeUser();
    const reader = await connect(userId, ["chats:read"]);
    const names = (await reader.listTools()).tools.map((tool) => tool.name).toSorted();
    expect(names).toEqual([
      "get_message",
      "list_agents",
      "list_chats",
      "list_models",
      "list_projects",
      "read_chat",
      "search_chats",
    ]);
    await reader.close();
    const other = await connect(userId, ["memory:read"]);
    expect((await other.listTools()).tools.map((tool) => tool.name)).toEqual(["list_memories"]);
    await other.close();
    const documents = await connect(userId, ["documents:read"]);
    expect((await documents.listTools()).tools.map((tool) => tool.name).toSorted()).toEqual([
      "list_documents",
      "read_document",
    ]);
    await documents.close();
    const none = await connect(userId, ["offline_access"]);
    expect((await none.listTools()).tools).toEqual([]);
    await none.close();
  });

  it("names the agents, models and projects a send can use", async () => {
    const userId = await makeUser();
    const model = await makeModel("Opus Test");
    await run(
      Effect.flatMap(Db, (db) =>
        db.insert(agents).values({
          id: uuidv7(),
          userId,
          name: "Researcher",
          description: "Digs into things",
          instructions: "Be thorough.",
        }),
      ),
    );
    const project = await run(
      ProjectService.use((projects) =>
        projects.create(userId, { name: "Launch", instructions: "" }),
      ),
    );
    const client = await connect(userId, ["chats:read"]);
    const agentsFound = await call(client, "list_agents");
    expect(agentsFound.structuredContent?.["agents"]).toEqual([
      expect.objectContaining({ name: "Researcher", description: "Digs into things" }),
    ]);
    const models = await call(client, "list_models");
    expect(models.structuredContent?.["models"]).toContainEqual(
      expect.objectContaining({ id: model.id, name: "Opus Test" }),
    );
    expect(models.content[0]?.text).toContain(model.id);
    const projects = await call(client, "list_projects");
    expect(projects.structuredContent?.["projects"]).toEqual([
      expect.objectContaining({ id: project.id, name: "Launch", role: "owner" }),
    ]);
    await client.close();
  });

  it("pages through chats and finds them by title", async () => {
    const userId = await makeUser();
    const model = await makeModel();
    for (const title of ["Alpha plan", "Beta notes", "Gamma ideas"])
      // oxlint-disable-next-line eslint/no-await-in-loop -- Activity order matters.
      await run(
        Effect.gen(function* () {
          const repo = yield* ChatRepo;
          const chat = yield* repo.createConversation({ userId, modelId: model.id });
          const db = yield* Db;
          yield* db.update(conversations).set({ title }).where(eq(conversations.id, chat.id));
        }),
      );
    const client = await connect(userId, ["chats:read"]);
    const first = await call(client, "list_chats", { limit: 2 });
    const page = first.structuredContent as { chats: Array<{ title: string }>; nextCursor: string };
    expect(page.chats).toHaveLength(2);
    const second = await call(client, "list_chats", { limit: 2, cursor: page.nextCursor });
    const rest = second.structuredContent as {
      chats: Array<{ title: string }>;
      nextCursor: string | null;
    };
    expect([...page.chats, ...rest.chats].map((chat) => chat.title).toSorted()).toEqual([
      "Alpha plan",
      "Beta notes",
      "Gamma ideas",
    ]);
    expect(rest.nextCursor).toBeNull();
    const found = await call(client, "search_chats", { query: "beta" });
    expect(found.structuredContent?.["hits"]).toEqual([
      expect.objectContaining({ title: "Beta notes" }),
    ]);
    const bad = await call(client, "list_chats", { cursor: "not-a-cursor" });
    expect(bad.isError).toBe(true);
    await client.close();
  });
});

type Answer = {
  status: string;
  chatId: string;
  messageId: string;
  generationId: string;
  answer?: string;
  questions?: { callId: string };
};
const send = async (client: Client, args: Record<string, unknown>) => {
  const response = await call(client, "send_message", args);
  expect(response.isError, response.content[0]?.text).toBeFalsy();
  return response.structuredContent as Answer;
};
const writer = async () => {
  const userId = await makeUser();
  await makeModel();
  return { userId, client: await connect(userId, ["chats:read", "chats:write"]) };
};
const messagesOf = (chatId: string) =>
  run(
    Effect.flatMap(Db, (db) =>
      db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, chatId))
        .orderBy(asc(messages.createdAt), asc(messages.id)),
    ),
  );

describe("delegating to the app", () => {
  it("starts a chat, answers, and marks the message with the app that sent it", async () => {
    answer = () => reply("Paris is the capital.");
    const { client } = await writer();
    const done = await send(client, { content: "Capital of France?" });
    expect(done).toMatchObject({ status: "complete", answer: "Paris is the capital." });
    const rows = await messagesOf(done.chatId);
    expect(rows.map((row) => [row.role, row.originClientName])).toEqual([
      ["user", "Claude"],
      ["assistant", null],
    ]);
    expect(rows[0]?.originClientId).toBe("client-1");
    await client.close();
  });

  it("continues the same chat with its history", async () => {
    answer = () => reply("First.");
    const { client } = await writer();
    const first = await send(client, { content: "One" });
    let prompt = "";
    answer = (input) => {
      prompt = JSON.stringify(input.prompt);
      return reply("Second.");
    };
    const second = await send(client, { content: "Two", chatId: first.chatId });
    // The model saw the earlier turn, not only the stored rows.
    expect(prompt).toContain("One");
    expect(prompt).toContain("First.");
    expect(second).toMatchObject({ status: "complete", chatId: first.chatId, answer: "Second." });
    expect((await messagesOf(first.chatId)).map((row) => row.content)).toEqual([
      "One",
      "First.",
      "Two",
      "Second.",
    ]);
    await client.close();
  });

  it("keeps a temporary chat out of the list", async () => {
    answer = () => reply("Noted.");
    const { client } = await writer();
    const kept = await send(client, { content: "Keep this" });
    const temporary = await send(client, { content: "Forget this", temporary: true });
    const listed = (await call(client, "list_chats")).structuredContent as {
      chats: Array<{ id: string }>;
    };
    expect(listed.chats.map((chat) => chat.id)).toEqual([kept.chatId]);
    expect(listed.chats.map((chat) => chat.id)).not.toContain(temporary.chatId);
    await client.close();
  });

  it("hands back a running answer, which get_message then waits for", async () => {
    const release = heldAnswer();
    const { client } = await writer();
    const started = await send(client, { content: "Take your time", waitSeconds: 0 });
    expect(started.status).toBe("running");
    const busy = await call(client, "send_message", { content: "Again", chatId: started.chatId });
    expect(busy.structuredContent).toMatchObject({ status: "busy" });
    release();
    const done = await call(client, "get_message", { messageId: started.messageId });
    expect(done.structuredContent).toMatchObject({ status: "complete", answer: "Held answer." });
    await client.close();
  });

  it("stops an answer, keeping what it wrote", async () => {
    heldAnswer();
    const { client } = await writer();
    const started = await send(client, { content: "Long one", waitSeconds: 0 });
    const stopped = await call(client, "stop_generation", { messageId: started.messageId });
    expect(stopped.structuredContent).toEqual({ stopped: true });
    const after = await call(client, "get_message", { messageId: started.messageId });
    expect(after.structuredContent).toMatchObject({ status: "aborted" });
    await client.close();
  });

  it("lets the calling agent answer the chat's clarifying questions", async () => {
    answer = askingAnswer({
      questions: [
        {
          question: "Which format?",
          options: [{ label: "Short" }, { label: "Long" }],
          multiSelect: false,
        },
      ],
    });
    const { client } = await writer();
    const asked = await send(client, { content: "Write a summary" });
    expect(asked.status).toBe("question");
    const callId = asked.questions!.callId;
    answer = () => reply("A short summary.");
    const done = await send(client, {
      chatId: asked.chatId,
      answer: { callId, response: { kind: "answers", answers: [{ selected: [0], custom: "" }] } },
    });
    expect(done).toMatchObject({ status: "complete", answer: "A short summary." });
    const rows = await messagesOf(asked.chatId);
    expect(rows.at(-2)?.questionResponse).toBeTruthy();
    // A later read still shows what was asked, though the asking answer has no text.
    const read = (await call(client, "read_chat", { chatId: asked.chatId })).structuredContent as {
      messages: Array<{ id: string; asked: string[] }>;
    };
    expect(read.messages.find((m) => m.id === asked.messageId)?.asked).toEqual(["Which format?"]);
    await client.close();
  });

  it("reports an attempt a retry in the app replaced, not the retry's answer", async () => {
    answer = () => reply("First attempt.");
    const { userId, client } = await writer();
    const done = await send(client, { content: "Try this" });
    answer = () => reply("Second attempt.");
    await run(
      Effect.gen(function* () {
        const chats = yield* ChatService;
        const engine = yield* StreamEngine;
        yield* chats.retryMessage({
          userId,
          conversationId: done.chatId,
          messageId: done.messageId,
        });
        yield* engine.subscribe(done.messageId, 0).pipe(Stream.runDrain);
      }),
    );
    const old = await call(client, "get_message", {
      messageId: done.messageId,
      generationId: done.generationId,
    });
    expect(old.structuredContent).toMatchObject({ status: "superseded" });
    const latest = await call(client, "get_message", { messageId: done.messageId });
    expect(latest.structuredContent).toMatchObject({
      status: "complete",
      answer: "Second attempt.",
    });
    await client.close();
  });

  it("reads a finished answer at once when told not to wait", async () => {
    answer = () => reply("Quick.");
    const { client } = await writer();
    const done = await send(client, { content: "Fast" });
    const now = await call(client, "get_message", { messageId: done.messageId, waitSeconds: 0 });
    expect(now.structuredContent).toMatchObject({ status: "complete", answer: "Quick." });
    await client.close();
  });

  it("starts an agent's chat on the agent's model", async () => {
    answer = () => reply("As the agent.");
    const { userId, client } = await writer();
    const agentModel = await makeModel("Agent Model");
    const agentId = uuidv7();
    await run(
      Effect.flatMap(Db, (db) =>
        db.insert(agents).values({
          id: agentId,
          userId,
          name: "Writer",
          description: "",
          instructions: "Write well.",
          modelId: agentModel.id,
        }),
      ),
    );
    const done = await send(client, { content: "Draft this", agentId });
    const rows = await messagesOf(done.chatId);
    expect(rows.at(-1)?.modelId).toBe(agentModel.id);
    await client.close();
  });

  it("stops only the attempt it names", async () => {
    answer = () => reply("Done already.");
    const { client } = await writer();
    const done = await send(client, { content: "Short" });
    const stale = await call(client, "stop_generation", {
      messageId: done.messageId,
      generationId: uuidv7(),
    });
    expect(stale.structuredContent).toMatchObject({ stopped: false, status: "superseded" });
    await client.close();
  });

  it("sends files with a message, read by the model like the composer's", async () => {
    const { client } = await writer();
    let prompt = "";
    answer = (input) => {
      prompt = JSON.stringify(input.prompt);
      return reply("Read it.");
    };
    const done = await send(client, {
      content: "Summarize the notes",
      files: [
        {
          name: "notes.txt",
          mediaType: "text/plain",
          data: Buffer.from("The launch moved to May.").toString("base64"),
        },
      ],
    });
    expect(done).toMatchObject({ status: "complete", answer: "Read it." });
    expect(prompt).toContain("The launch moved to May.");
    const [question] = await messagesOf(done.chatId);
    const files = await run(
      Effect.flatMap(AttachmentRepo, (attachments) => attachments.listForMessages([question!.id])),
    );
    expect(files.map((file) => file.fileName)).toEqual(["notes.txt"]);

    const notBase64 = await call(client, "send_message", {
      content: "x",
      files: [{ name: "a.txt", data: "not base64!" }],
    });
    expect(notBase64.content[0]?.text).toContain("isn't base64");
    const tooMany = await call(client, "send_message", {
      content: "x",
      files: Array.from({ length: 6 }, (_, i) => ({ name: `${i}.txt`, data: "aGk=" })),
    });
    expect(tooMany.content[0]?.text).toContain("at most 5 files");
    const withAnswer = await call(client, "send_message", {
      chatId: done.chatId,
      answer: { callId: "x", response: { kind: "skip" } },
      files: [{ name: "a.txt", data: "aGk=" }],
    });
    expect(withAnswer.isError).toBe(true);
    await client.close();
  });

  it("hands back an answer's files as links the client reads with the same access", async () => {
    const { userId, client } = await writer();
    answer = () => reply("Here is the report.");
    const done = await send(client, { content: "Make a report" });
    // A file the answer made, as a tool's returned file is stored.
    const stored = await run(
      Effect.flatMap(AttachmentService, (attachments) =>
        attachments.upload({
          userId,
          fileName: "report.txt",
          declaredMediaType: "text/plain",
          bytes: new TextEncoder().encode("Quarterly numbers."),
        }),
      ),
    );
    await run(
      Effect.flatMap(Db, (db) =>
        db
          .insert(messageAttachments)
          .values({ messageId: done.messageId, attachmentId: stored.id, position: 0 }),
      ),
    );
    const read = await call(client, "get_message", { messageId: done.messageId });
    const uri = `chat://attachments/${stored.id}`;
    expect(read.structuredContent?.["files"]).toEqual([
      expect.objectContaining({ name: "report.txt", uri }),
    ]);
    expect(read.content).toContainEqual(
      expect.objectContaining({ type: "resource_link", uri, name: "report.txt" }),
    );
    const contents = await client.readResource({ uri });
    expect(contents.contents[0]).toMatchObject({ uri, text: "Quarterly numbers." });
    const other = await connect(await makeUser(), ["chats:read"]);
    await expect(other.readResource({ uri })).rejects.toMatchObject({
      code: -32602,
      message: "There is no file at that address.",
    });
    await other.close();
    await client.close();
  });

  it("explains a send it cannot make", async () => {
    const { client } = await writer();
    const neither = await call(client, "send_message", {});
    expect(neither.isError).toBe(true);
    const missing = await call(client, "send_message", { content: "Hi", chatId: uuidv7() });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain("no chat with that id");
    const other = await makeUser();
    const theirs = await connect(other, ["chats:read", "chats:write"]);
    answer = () => reply("Mine.");
    const mine = await send(client, { content: "Private" });
    const peek = await call(theirs, "get_message", { messageId: mine.messageId });
    expect(peek.isError).toBe(true);
    const stop = await call(theirs, "stop_generation", { messageId: mine.messageId });
    expect(stop.isError).toBe(true);
    const intrude = await call(theirs, "send_message", { content: "Hello", chatId: mine.chatId });
    expect(intrude.isError).toBe(true);
    expect((await messagesOf(mine.chatId)).map((row) => row.content)).toEqual(["Private", "Mine."]);
    const project = await call(theirs, "send_message", {
      content: "In there",
      projectId: uuidv7(),
    });
    expect(project.content[0]?.text).toContain("project");
    await theirs.close();
    await client.close();
  });

  it("says a chat has a computer and still continues it", async () => {
    const { client } = await writer();
    answer = () => reply("Listed the folder.");
    const chat = await send(client, { content: "What's in this folder?" });
    await run(
      Effect.flatMap(Db, (db) =>
        db
          .update(conversations)
          .set({ machineId: "machine-1" })
          .where(eq(conversations.id, chat.chatId)),
      ),
    );
    const list = (await call(client, "list_chats", {})).structuredContent as {
      chats: Array<{ id: string; computer: boolean }>;
    };
    expect(list.chats.find((c) => c.id === chat.chatId)?.computer).toBe(true);
    const read = await call(client, "read_chat", { chatId: chat.chatId });
    expect(read.structuredContent).toMatchObject({ computer: true });
    expect(read.content[0]?.text).toContain("This chat has a computer");
    answer = () => reply("Still here.");
    await send(client, { content: "And now?", chatId: chat.chatId });
    expect((await messagesOf(chat.chatId)).map((row) => row.content)).toEqual([
      "What's in this folder?",
      "Listed the folder.",
      "And now?",
      "Still here.",
    ]);
    await client.close();
  });
});

describe("API keys", () => {
  const keyGrant = (token: string) => runtime.runPromise(apiKeyGrant(token, resource));
  const makeKey = (userId: string, scopes: ReadonlyArray<McpScope>, lifetimeDays: 30 | null = 30) =>
    run(
      Effect.flatMap(ApiKeys, (keys) => keys.create(userId, { name: "n8n", scopes, lifetimeDays })),
    );

  it("acts as its person with the key's scopes, named after the key", async () => {
    const userId = await makeUser();
    await makeModel();
    const { key, secret } = await makeKey(userId, ["chats:read", "chats:write"]);
    expect(secret.startsWith("nma_")).toBe(true);
    expect(key.start).toBe(secret.slice(0, key.start.length));
    const client = await connect(userId, [], { bearer: { token: secret, grantFor: keyGrant } });
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(tools).toContain("send_message");
    expect(tools).not.toContain("read_document");
    answer = () => reply("Done.");
    const sent = await send(client, { content: "From a script" });
    expect((await messagesOf(sent.chatId)).map((row) => row.originClientName)).toEqual([
      "n8n (API key)",
      null,
    ]);
    const [listed] = await run(Effect.flatMap(ApiKeys, (keys) => keys.list(userId)));
    expect(listed?.lastUsedAt).not.toBeNull();
    await client.close();
  });

  it("stops working once revoked, expired or no longer allowed", async () => {
    const userId = await makeUser();
    const revoked = await makeKey(userId, ["chats:read"]);
    expect(await keyGrant(revoked.secret)).toMatchObject({ userId, scopes: ["chats:read"] });
    // Another person cannot revoke it; its owner can.
    const other = await makeUser();
    await run(Effect.flatMap(ApiKeys, (keys) => keys.revoke(other, revoked.key.id)));
    expect(await keyGrant(revoked.secret)).not.toBeNull();
    await run(Effect.flatMap(ApiKeys, (keys) => keys.revoke(userId, revoked.key.id)));
    expect(await keyGrant(revoked.secret)).toBeNull();

    const expired = await makeKey(userId, ["chats:read"]);
    await run(
      Effect.flatMap(Db, (db) =>
        db
          .update(apiKeys)
          .set({ expiresAt: sql`now() - interval '1 second'` })
          .where(eq(apiKeys.id, expired.key.id)),
      ),
    );
    expect(await keyGrant(expired.secret)).toBeNull();

    const forever = await makeKey(userId, ["chats:read"], null);
    // Through the endpoint, whose SDK refuses a token it sees no end to.
    const client = await connect(userId, [], {
      bearer: { token: forever.secret, grantFor: keyGrant },
    });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("list_chats");
    await client.close();
    await run(
      Effect.flatMap(Db, (db) =>
        db
          .update(defaultCapabilities)
          .set({ capabilities: sql`capabilities || '{"apiKeys":false}'::jsonb` }),
      ),
    );
    try {
      expect(await keyGrant(forever.secret)).toBeNull();
    } finally {
      await run(
        Effect.flatMap(Db, (db) =>
          db
            .update(defaultCapabilities)
            .set({ capabilities: sql`capabilities || '{"apiKeys":true}'::jsonb` }),
        ),
      );
    }
    expect(await keyGrant("nma_not-a-key")).toBeNull();
  });

  it("holds a key to the rule its settings page reads, a ban and the mcp capability included", async () => {
    const userId = await makeUser();
    const { secret } = await makeKey(userId, ["chats:read"]);
    expect(await run(apiKeysAllowed(userId))).toBe(true);
    await run(
      Effect.flatMap(Db, (db) =>
        db.update(user).set({ banned: true, banExpires: null }).where(eq(user.id, userId)),
      ),
    );
    expect(await run(apiKeysAllowed(userId))).toBe(false);
    expect(await keyGrant(secret)).toBeNull();
    await run(
      Effect.flatMap(Db, (db) => db.update(user).set({ banned: false }).where(eq(user.id, userId))),
    );
    await run(
      Effect.flatMap(Db, (db) =>
        db
          .update(defaultCapabilities)
          .set({ capabilities: sql`capabilities || '{"mcp":false}'::jsonb` }),
      ),
    );
    try {
      expect(await run(apiKeysAllowed(userId))).toBe(false);
      expect(await keyGrant(secret)).toBeNull();
    } finally {
      await run(
        Effect.flatMap(Db, (db) =>
          db
            .update(defaultCapabilities)
            .set({ capabilities: sql`capabilities || '{"mcp":true}'::jsonb` }),
        ),
      );
    }
    expect(await keyGrant(secret)).not.toBeNull();
  });

  it("holds a person to the limit on keys", async () => {
    const userId = await makeUser();
    for (let i = 0; i < MAX_API_KEYS; i++) await makeKey(userId, ["chats:read"]);
    const over = await runtime.runPromise(
      Effect.result(
        Effect.flatMap(ApiKeys, (keys) =>
          keys.create(userId, { name: "one more", scopes: ["chats:read"], lifetimeDays: 30 }),
        ),
      ),
    );
    expect(over._tag).toBe("Failure");
  });
});

describe("managing chats", () => {
  const chatRow = (chatId: string) =>
    run(
      Effect.flatMap(Db, (db) =>
        db.select().from(conversations).where(eq(conversations.id, chatId)),
      ).pipe(Effect.map(([row]) => row!)),
    );
  const listed = async (client: Client) =>
    (
      (await call(client, "list_chats")).structuredContent as {
        chats: Array<{ id: string }>;
      }
    ).chats.map((chat) => chat.id);

  it("reads a chat page by page, oldest first, marking what an app sent", async () => {
    const { client } = await writer();
    answer = () => reply("First answer.");
    const first = await send(client, { content: "First question" });
    answer = () => reply("Second answer.");
    await send(client, { content: "Second question", chatId: first.chatId });

    const latest = await call(client, "read_chat", { chatId: first.chatId, turns: 1 });
    expect(latest.isError).toBeFalsy();
    const page = {
      transcript: latest.content[0]!.text!,
      ...(latest.structuredContent as {
        olderCursor: string | null;
        messages: Array<{ content: string; via: string | null }>;
      }),
    };
    expect(page.transcript).toContain("Second question");
    expect(page.transcript).toContain("Second answer.");
    expect(page.transcript).toContain("via Claude");
    expect(page.transcript).not.toContain("First question");
    expect(page.messages.map((m) => [m.content, m.via])).toEqual([
      ["Second question", "Claude"],
      ["Second answer.", null],
    ]);
    expect(page.olderCursor).not.toBeNull();

    const older = await call(client, "read_chat", {
      chatId: first.chatId,
      turns: 1,
      cursor: page.olderCursor,
    });
    const before = {
      transcript: older.content[0]!.text!,
      ...(older.structuredContent as { olderCursor: string | null }),
    };
    expect(before.transcript).toContain("First question");
    expect(before.transcript).toContain("First answer.");
    expect(before.transcript.indexOf("First question")).toBeLessThan(
      before.transcript.indexOf("First answer."),
    );
    expect(before.transcript).not.toContain("Second");
    expect(before.olderCursor).toBeNull();

    const whole = (await call(client, "read_chat", { chatId: first.chatId })).structuredContent as {
      messages: Array<{ role: string }>;
    };
    expect(whole.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);

    const bogus = await call(client, "read_chat", { chatId: first.chatId, cursor: uuidv7() });
    expect(bogus.isError).toBe(true);
    // A turn start from another of this person's chats is no cursor here.
    answer = () => reply("Elsewhere.");
    const elsewhere = await send(client, { content: "Other chat" });
    const foreignStart = (await messagesOf(elsewhere.chatId))[0]!.id;
    const foreign = await call(client, "read_chat", { chatId: first.chatId, cursor: foreignStart });
    expect(foreign.isError).toBe(true);
    // Nor is the middle of a turn.
    const answerId = (await messagesOf(first.chatId))[1]!.id;
    const mid = await call(client, "read_chat", { chatId: first.chatId, cursor: answerId });
    expect(mid.isError).toBe(true);
    const other = await connect(await makeUser(), ["chats:read"]);
    const peek = await call(other, "read_chat", { chatId: first.chatId });
    expect(peek.isError).toBe(true);
    await other.close();
    await client.close();
  });

  it("reads nothing of a deleted chat", async () => {
    const { userId, client } = await writer();
    answer = () => reply("Soon gone.");
    const done = await send(client, { content: "Delete me" });
    await run(
      Effect.flatMap(ChatService, (chats) =>
        chats.deleteConversation({ userId, conversationId: done.chatId }),
      ),
    );
    const read = await call(client, "read_chat", { chatId: done.chatId });
    expect(read.isError).toBe(true);
    await client.close();
  });

  it("retries an answer, dropping what came after it", async () => {
    const { client } = await writer();
    answer = () => reply("Draft one.");
    const first = await send(client, { content: "Write" });
    answer = () => reply("Later.");
    await send(client, { content: "More", chatId: first.chatId });
    answer = () => reply("Draft two.");
    const retried = (await call(client, "retry_message", { messageId: first.messageId }))
      .structuredContent as Answer;
    expect(retried).toMatchObject({
      status: "complete",
      messageId: first.messageId,
      answer: "Draft two.",
    });
    expect(retried.generationId).not.toBe(first.generationId);
    expect((await messagesOf(first.chatId)).map((row) => row.content)).toEqual([
      "Write",
      "Draft two.",
    ]);
    const old = await call(client, "get_message", {
      messageId: first.messageId,
      generationId: first.generationId,
    });
    expect(old.structuredContent).toMatchObject({ status: "superseded" });

    const unknownModel = await call(client, "retry_message", {
      messageId: first.messageId,
      modelId: uuidv7(),
    });
    expect(unknownModel.content[0]?.text).toContain("That model isn't available");
    const other = await connect(await makeUser(), ["chats:read", "chats:write"]);
    const theirs = await call(other, "retry_message", { messageId: first.messageId });
    expect(theirs.content[0]?.text).toBe("There is no message with that id.");
    const question = (await messagesOf(first.chatId))[0]!;
    // Their own message is named as one, someone else's is not even admitted to.
    expect(
      (await call(client, "retry_message", { messageId: question.id })).content[0]?.text,
    ).toContain("this takes an answer's messageId");
    expect((await call(other, "retry_message", { messageId: question.id })).content[0]?.text).toBe(
      "There is no message with that id.",
    );
    expect((await messagesOf(first.chatId)).map((row) => row.content)).toEqual([
      "Write",
      "Draft two.",
    ]);
    await other.close();
    await client.close();
  });

  it("says why an answer failed, in the result an app reads", async () => {
    const { client } = await writer();
    answer = () =>
      Stream.fail(
        new ProviderUnreachable({ providerId, message: "InvalidKey: API key expired." }),
      ) as never;
    const failed = (await send(client, { content: "Hello" })) as { status: string; error?: string };
    expect(failed.status).toBe("error");
    expect(failed.error).toContain("API key expired.");
    expect(failed.error).not.toMatch(/^Cause|ProviderUnreachable/);
    await client.close();
  });

  it("branches a chat into a new one that goes its own way", async () => {
    const { client } = await writer();
    answer = () => reply("Base.");
    const base = await send(client, { content: "Start" });
    // The default copies through the latest answer that finished, past a failed one.
    answer = () => Stream.die("the provider fell over");
    await send(client, { content: "Then fail", chatId: base.chatId });
    const branched = await call(client, "branch_chat", { chatId: base.chatId });
    const branch = branched.structuredContent as { chatId: string };
    expect(branch.chatId).not.toBe(base.chatId);
    answer = () => reply("Branch only.");
    await send(client, { content: "Diverge", chatId: branch.chatId });
    expect((await messagesOf(branch.chatId)).map((row) => row.content)).toEqual([
      "Start",
      "Base.",
      "Diverge",
      "Branch only.",
    ]);
    expect((await messagesOf(base.chatId)).slice(0, 2).map((row) => row.content)).toEqual([
      "Start",
      "Base.",
    ]);
    await client.close();
  });

  it("keeps, archives, restores and renames chats", async () => {
    const { client } = await writer();
    answer = () => reply("Fine.");
    const temporary = await send(client, { content: "Scratch", temporary: true });
    expect(await listed(client)).not.toContain(temporary.chatId);
    const early = await call(client, "archive_chat", { chatId: temporary.chatId });
    expect(early.isError).toBe(true);
    expect((await chatRow(temporary.chatId)).temporary).toBe(true);
    expect((await call(client, "keep_chat", { chatId: temporary.chatId })).isError).toBeFalsy();
    expect(await listed(client)).toContain(temporary.chatId);
    expect((await chatRow(temporary.chatId)).temporary).toBe(false);

    await call(client, "archive_chat", { chatId: temporary.chatId });
    expect(await listed(client)).not.toContain(temporary.chatId);
    await call(client, "archive_chat", { chatId: temporary.chatId, archived: false });
    expect(await listed(client)).toContain(temporary.chatId);

    await call(client, "rename_chat", { chatId: temporary.chatId, title: "  Plans  " });
    expect((await chatRow(temporary.chatId)).title).toBe("Plans");
    const blank = await call(client, "rename_chat", { chatId: temporary.chatId, title: " " });
    expect(blank.isError).toBe(true);

    const other = await connect(await makeUser(), ["chats:read", "chats:write"]);
    const theirs = await call(other, "archive_chat", { chatId: temporary.chatId });
    expect(theirs.isError).toBe(true);
    expect((await chatRow(temporary.chatId)).archivedAt).toBeNull();
    await other.close();
    await client.close();
  });
});

describe("putting approvals to the app's person", () => {
  /** The live answer this person's newest turn is writing. */
  const streamingFor = (userId: string) =>
    run(
      Effect.flatMap(Db, (db) =>
        db
          .select({ id: messages.id, conversationId: messages.conversationId })
          .from(messages)
          .innerJoin(conversations, eq(conversations.id, messages.conversationId))
          .where(and(eq(conversations.userId, userId), eq(messages.status, "streaming"))),
      ).pipe(Effect.map(([row]) => row!)),
    );

  /** An answer that parks one change on the person, as an integration call does, then says what came of it. */
  const parkFor = async (userId: string, callId: string, n: number) => {
    const live = await streamingFor(userId);
    return run(
      Effect.flatMap(IntegrationApprovals, (approvals) =>
        approvals.request(userId, {
          callId: `${callId}-${n}`,
          conversationId: live.conversationId,
          messageId: live.id,
          integrationId: "jira",
          connectionId: "account",
          account: null,
          tool: "create_issue",
          label: "Create an issue",
          access: "write",
          summary: `Create PROJ-${n}`,
          targets: [],
        }),
      ),
    );
  };

  /**
   * An answer that parks `count` changes on the person one after another, as
   * integration calls do, then says what came of them.
   */
  const approvingAnswer = (userId: string, count = 1) => {
    const callId = `call-${uuidv7()}`;
    answer = () =>
      Stream.fromEffect(
        Effect.promise(async () => {
          const outcomes: string[] = [];
          for (let n = 1; n <= count; n++) {
            const outcome = await parkFor(userId, callId, n);
            outcomes.push(`${outcome.answer} via ${outcome.via}`);
          }
          return outcomes.join("; ");
        }),
      ).pipe(Stream.flatMap((outcome) => reply(`Outcome: ${outcome}`)));
    return `${callId}-1`;
  };

  /** Waits on the registration itself, never on time. */
  const parked = (userId: string) =>
    run(
      Effect.flatMap(IntegrationApprovals, (approvals) => approvals.pending(userId)).pipe(
        Effect.repeat({ until: (pending) => pending.length > 0 }),
      ),
    );

  it("asks through the client's own form and goes on with the answer", async () => {
    const userId = await makeUser();
    await makeModel();
    const asked: Array<{ message: string; requestedSchema?: unknown }> = [];
    const client = await connect(userId, ["chats:read", "chats:write"], {
      elicit: async (params) => {
        asked.push(params);
        return { action: "accept", content: { decision: "allow" } };
      },
    });
    approvingAnswer(userId);
    const done = await send(client, { content: "File the bug" });
    expect(done).toMatchObject({ status: "complete", answer: "Outcome: allow via Claude" });
    expect(asked).toHaveLength(1);
    // What the in-app card shows: the tool as the person knows it, and what it would do.
    expect(asked[0]!.message).toContain("Create an issue in A service?");
    expect(asked[0]!.message).toContain("Create PROJ-1");
    expect(asked[0]!.message).toContain("This will change with your A service account.");
    expect(JSON.stringify(asked[0]!.requestedSchema)).toContain('"deny"');
    // The send was not made twice by the call that came back with the answer.
    expect((await messagesOf(done.chatId)).map((row) => row.content)).toEqual([
      "File the bug",
      "Outcome: allow via Claude",
    ]);
    await client.close();
  });

  it("takes a declined form as declining the change", async () => {
    const userId = await makeUser();
    await makeModel();
    const client = await connect(userId, ["chats:read", "chats:write"], {
      elicit: async () => ({ action: "decline" }),
    });
    approvingAnswer(userId);
    const done = await send(client, { content: "File it" });
    expect(done).toMatchObject({ status: "complete", answer: "Outcome: deny via Claude" });
    await client.close();
  });

  it("sends the person to the app when the client cannot ask, and reads on once they decided", async () => {
    const userId = await makeUser();
    await makeModel();
    const client = await connect(userId, ["chats:read", "chats:write"]);
    const callId = approvingAnswer(userId);
    const waiting = (await call(client, "send_message", { content: "File it" }))
      .structuredContent as Answer & { waiting: Array<{ kind: string; summary: string }> };
    expect(waiting.status).toBe("needs_person");
    expect(waiting.waiting).toEqual([
      expect.objectContaining({ kind: "approval", summary: "Create PROJ-1" }),
    ]);
    const still = await call(client, "get_message", {
      messageId: waiting.messageId,
      waitSeconds: 0,
    });
    expect(still.structuredContent).toMatchObject({ status: "needs_person" });
    // The person decides in the app's own card, which names no question.
    expect(
      await run(
        Effect.flatMap(IntegrationApprovals, (approvals) =>
          approvals.decide(userId, callId, "allow"),
        ),
      ),
    ).toBe(true);
    const done = await call(client, "get_message", { messageId: waiting.messageId });
    expect(done.structuredContent).toMatchObject({
      status: "complete",
      answer: "Outcome: allow via null",
    });
    await client.close();
  });

  it("never asks through a grant that may only read, or a client of the older protocol", async () => {
    const userId = await makeUser();
    await makeModel();
    const elicit: Elicit = async () => ({ action: "accept", content: { decision: "allow" } });
    const sender = await connect(userId, ["chats:read", "chats:write"]);
    const callId = approvingAnswer(userId);
    const started = await send(sender, { content: "File it", waitSeconds: 0 });
    await parked(userId);
    const reader = await connect(userId, ["chats:read"], { elicit });
    const read = await call(reader, "get_message", {
      messageId: started.messageId,
      waitSeconds: 1,
    });
    expect(read.structuredContent).toMatchObject({ status: "needs_person" });
    const legacy = await connect(userId, ["chats:read", "chats:write"], { elicit, era: "legacy" });
    const old = await call(legacy, "get_message", { messageId: started.messageId, waitSeconds: 0 });
    expect(old.structuredContent).toMatchObject({ status: "needs_person" });
    await run(
      Effect.flatMap(IntegrationApprovals, (approvals) => approvals.decide(userId, callId, "deny")),
    );
    const done = await call(sender, "get_message", { messageId: started.messageId });
    expect(done.structuredContent).toMatchObject({ status: "complete" });
    for (const client of [sender, reader, legacy]) await client.close();
  });

  it("asks for each change in turn, within the one call", async () => {
    const userId = await makeUser();
    await makeModel();
    const asked: string[] = [];
    const client = await connect(userId, ["chats:read", "chats:write"], {
      elicit: async (params) => {
        asked.push(params.message);
        return { action: "accept", content: { decision: asked.length === 1 ? "allow" : "deny" } };
      },
    });
    approvingAnswer(userId, 2);
    const done = await send(client, { content: "File two" });
    expect(done).toMatchObject({
      status: "complete",
      answer: "Outcome: allow via Claude; deny via Claude",
    });
    expect(asked.map((message) => message.includes("PROJ-2"))).toEqual([false, true]);
    await client.close();
  });

  it("leaves a dismissed form to the app, whose card still decides", async () => {
    const userId = await makeUser();
    await makeModel();
    let callId = "";
    const client = await connect(userId, ["chats:read", "chats:write"], {
      elicit: async () => {
        // The person closes the form and approves in the app instead.
        await run(
          Effect.flatMap(IntegrationApprovals, (approvals) =>
            approvals.decide(userId, callId, "allow"),
          ),
        );
        return { action: "cancel" };
      },
    });
    callId = approvingAnswer(userId);
    const done = await send(client, { content: "File it" });
    expect(done).toMatchObject({ status: "complete", answer: "Outcome: allow via null" });
    await client.close();
  });

  it("never asks again about a form the person dismissed, while the call goes on", async () => {
    const userId = await makeUser();
    await makeModel();
    const callId = `call-${uuidv7()}`;
    const asked: string[] = [];
    let firstAsked!: () => void;
    const asking = new Promise<void>((resolve) => (firstAsked = resolve));
    const client = await connect(userId, ["chats:read", "chats:write"], {
      elicit: async (params) => {
        asked.push(params.message);
        if (params.message.includes("PROJ-1")) {
          firstAsked();
          return { action: "cancel" };
        }
        // Asked about the last change: the dismissed one is still waiting,
        // and the person settles it in the app now.
        if (params.message.includes("PROJ-3"))
          await run(
            Effect.flatMap(IntegrationApprovals, (approvals) =>
              approvals.decide(userId, `${callId}-1`, "allow"),
            ),
          );
        return { action: "accept", content: { decision: "allow" } };
      },
    });
    answer = () =>
      Stream.fromEffect(
        Effect.promise(async () => {
          // The first change waits on, dismissed; two more come one after
          // another, each in a round of its own.
          const first = parkFor(userId, callId, 1);
          await asking;
          const second = await parkFor(userId, callId, 2);
          const third = await parkFor(userId, callId, 3);
          return [await first, second, third].map((o) => `${o.answer} via ${o.via}`).join("; ");
        }),
      ).pipe(Stream.flatMap((outcome) => reply(`Outcome: ${outcome}`)));
    const done = await send(client, { content: "File three" });
    expect(done).toMatchObject({
      status: "complete",
      answer: "Outcome: allow via null; allow via Claude; allow via Claude",
    });
    expect(asked.filter((message) => message.includes("PROJ-1"))).toHaveLength(1);
    await client.close();
  });

  it("goes on with a retry the person approved without retrying it again", async () => {
    const userId = await makeUser();
    await makeModel();
    const client = await connect(userId, ["chats:read", "chats:write"], {
      elicit: async () => ({ action: "accept", content: { decision: "allow" } }),
    });
    answer = () => reply("First.");
    const first = await send(client, { content: "File it" });
    approvingAnswer(userId);
    const retried = (await call(client, "retry_message", { messageId: first.messageId }))
      .structuredContent as Answer;
    expect(retried).toMatchObject({ status: "complete", answer: "Outcome: allow via Claude" });
    // One retry: a second would have replaced this attempt again.
    expect(retried.generationId).toBe((await messagesOf(first.chatId))[1]!.generationId);
    await client.close();
  });

  it("passes a service's own form on and sends back what the person filled in", async () => {
    const userId = await makeUser();
    await makeModel();
    let schema: unknown;
    const client = await connect(userId, ["chats:read", "chats:write"], {
      elicit: async (params) => {
        schema = params.requestedSchema;
        return { action: "accept", content: { project: "api", count: 3 } };
      },
    });
    answer = () =>
      Stream.fromEffect(
        Effect.promise(async () => {
          const live = await streamingFor(userId);
          return run(
            Effect.flatMap(IntegrationApprovals, (approvals) =>
              approvals.elicit(userId, {
                callId: `call-${uuidv7()}`,
                conversationId: live.conversationId,
                messageId: live.id,
                integrationId: "jira",
                connectionId: "account",
                account: null,
                tool: "create_issue",
                label: "Create an issue",
                access: "write",
                summary: null,
                targets: [],
                prompt: {
                  mode: "form",
                  message: "Which project?",
                  fields: [
                    {
                      key: "project",
                      label: "Project",
                      description: null,
                      kind: "choice",
                      required: true,
                      options: [
                        { value: "web", label: "Web" },
                        { value: "api", label: "API" },
                      ],
                    },
                    {
                      key: "count",
                      label: "Count",
                      description: null,
                      kind: "integer",
                      required: false,
                      min: 1,
                    },
                  ],
                },
              }),
            ),
          );
        }),
      ).pipe(Stream.flatMap((reply_) => reply(`Got: ${JSON.stringify(reply_)}`)));
    const done = await send(client, { content: "File it" });
    expect(done.answer).toBe(
      `Got: ${JSON.stringify({ action: "accept", values: { project: "api", count: 3 } })}`,
    );
    expect(JSON.stringify(schema)).toContain('"const":"api"');
    await client.close();
  });

  it("refuses answers that come back without the turn they belong to", async () => {
    const userId = await makeUser();
    await makeModel();
    const client = await connect(userId, ["chats:read", "chats:write"]);
    const stray = (await client.request({
      method: "tools/call",
      params: {
        name: "send_message",
        arguments: { content: "Again" },
        inputResponses: { "ask-0": { action: "accept", content: { decision: "allow" } } },
      },
    } as never)) as { isError?: boolean; content: Array<{ text?: string }> };
    expect(stray.isError).toBe(true);
    expect(stray.content[0]?.text).toContain("without the turn");
    await client.close();
  });
});

describe("the person's library", () => {
  it("lists, searches and reads knowledge the person may use, and nobody else's", async () => {
    const userId = await makeUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeService, (knowledge) =>
        knowledge.create(userId, { name: "Handbook", description: "How we work" }),
      ),
    );
    await run(
      Effect.flatMap(KnowledgeService, (knowledge) =>
        knowledge.addNote(userId, {
          collectionId,
          title: "Travel",
          content: "Book trains for trips under four hours. Flights need approval.",
        }),
      ),
    );
    await run(
      Effect.gen(function* () {
        const indexer = yield* KnowledgeIndexer;
        for (let step = 0; step < 20; step++) if (!(yield* indexer.runExtraction())) break;
      }),
    );
    const client = await connect(userId, ["knowledge:read"]);
    const listed = await call(client, "list_collections");
    expect(listed.structuredContent?.["collections"]).toEqual([
      expect.objectContaining({ id: collectionId, name: "Handbook" }),
    ]);
    const found = await call(client, "search_knowledge", {
      query: "trains",
      collectionIds: [collectionId],
    });
    expect(found.isError, found.content[0]?.text).toBeFalsy();
    const passages = found.structuredContent?.["passages"] as Array<{
      documentId: string;
      versionId: string;
      content: string;
      url: string;
    }>;
    expect(passages[0]?.content).toContain("Book trains");
    expect(passages[0]?.url).toContain(`https://chat.example/api/knowledge/${collectionId}/`);
    const read = await call(client, "read_knowledge_document", {
      collectionId,
      documentId: passages[0]!.documentId,
      versionId: passages[0]!.versionId,
    });
    expect(read.structuredContent).toMatchObject({ nextOffset: null });
    expect(read.content[0]?.text).toContain("Flights need approval.");

    const stranger = await connect(await makeUser(), ["knowledge:read"]);
    const peek = await call(stranger, "search_knowledge", {
      query: "trains",
      collectionIds: [collectionId],
    });
    expect(peek.isError).toBe(true);
    const peekRead = await call(stranger, "read_knowledge_document", {
      collectionId,
      documentId: passages[0]!.documentId,
      versionId: passages[0]!.versionId,
    });
    expect(peekRead.isError).toBe(true);
    await stranger.close();
    await client.close();
  });

  it("saves, lists, changes and forgets the person's memories", async () => {
    const userId = await makeUser();
    await run(
      Effect.flatMap(Db, (db) =>
        db.execute(`update tools set enabled = true where name = 'memory'` as never),
      ),
    );
    const client = await connect(userId, ["memory:read", "memory:write"]);
    const saved = await call(client, "save_memory", { content: "Prefers trains over flights." });
    expect(saved.isError, saved.content[0]?.text).toBeFalsy();
    const id = saved.structuredContent?.["id"] as string;
    const sensitive = await call(client, "save_memory", {
      content: "Card 4111 1111 1111 1111",
    });
    expect(sensitive.isError).toBe(true);
    await call(client, "update_memory", { memoryId: id, content: "Prefers night trains." });
    const listed = await call(client, "list_memories");
    expect(listed.structuredContent?.["memories"]).toEqual([
      expect.objectContaining({ id, content: "Prefers night trains." }),
    ]);
    const other = await connect(await makeUser(), ["memory:read", "memory:write"]);
    const theirs = await call(other, "delete_memory", { memoryId: id });
    expect(theirs.isError).toBe(true);
    await other.close();
    expect((await call(client, "delete_memory", { memoryId: id })).isError).toBeFalsy();
    expect((await call(client, "list_memories")).structuredContent?.["memories"]).toEqual([]);

    await run(
      Effect.flatMap(Db, (db) =>
        db.execute(`update tools set enabled = false where name = 'memory'` as never),
      ),
    );
    const off = await call(client, "list_memories");
    expect(off.content[0]?.text).toContain("isn't available");
    await client.close();
  });

  it("offers the person's skills as prompts and their files to read, not the app's own", async () => {
    const userId = await makeUser();
    const skill = await run(
      Effect.flatMap(SkillService, (skills) =>
        skills.save(userId, {
          files: [
            {
              path: "SKILL.md",
              content:
                "---\nname: travel-policy\ndescription: Plan trips by the policy\n---\nRead rules.md first.",
            },
            { path: "rules.md", content: "Trains under four hours." },
          ],
        }),
      ),
    );
    // Manual-only: never offered on its own, but a prompt the person can pick.
    await run(
      Effect.flatMap(SkillService, (skills) =>
        skills.save(userId, {
          files: [
            {
              path: "SKILL.md",
              content:
                "---\nname: release-notes\ndescription: Write release notes\ndisable-model-invocation: true\n---\nList changes.",
            },
          ],
        }),
      ),
    );
    const client = await connect(userId, ["skills:read"]);
    const listed = await call(client, "list_skills");
    expect(listed.structuredContent?.["skills"]).toEqual([
      { skillId: skill.id, name: "travel-policy", description: "Plan trips by the policy" },
    ]);
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name)).toEqual([
      "release-notes",
      "travel-policy",
    ]);
    const prompt = await client.getPrompt({ name: "travel-policy" });
    expect(JSON.stringify(prompt.messages)).toContain("Read rules.md first.");
    const rules = await call(client, "read_skill_file", { skillId: skill.id, path: "rules.md" });
    expect(rules.content[0]?.text).toBe("Trains under four hours.");
    const stranger = await connect(await makeUser(), ["skills:read"]);
    expect((await call(stranger, "read_skill_file", { skillId: skill.id })).isError).toBe(true);
    expect((await stranger.listPrompts()).prompts).toEqual([]);
    await stranger.close();
    await client.close();
  });

  it("writes a project's documents as the person, only over blocks the read showed", async () => {
    const userId = await makeUser();
    const project = await run(
      Effect.flatMap(ProjectService, (projects) =>
        projects.create(userId, { name: "Launch", instructions: "" }),
      ),
    );
    const client = await connect(userId, ["documents:read", "documents:write"]);
    const created = await call(client, "create_document", {
      projectId: project.id,
      title: "Plan",
      content: "First idea.\n\nSecond idea.",
    });
    expect(created.isError, created.content[0]?.text).toBeFalsy();
    const documentId = created.structuredContent?.["documentId"] as string;
    const listed = await call(client, "list_documents", { projectId: project.id });
    expect(listed.structuredContent?.["documents"]).toEqual([
      expect.objectContaining({ id: documentId, title: "Plan", canEdit: true }),
    ]);
    const read = await call(client, "read_document", { documentId });
    const { xml, seen } = read.structuredContent as { xml: string; seen: string };
    const first = /id="([^"]+)"/.exec(xml)![1]!;
    expect(xml).toContain("First idea.");

    const edited = await call(client, "edit_document", {
      documentId,
      seen,
      target: first,
      content: "Better idea.",
    });
    expect(edited.isError, edited.content[0]?.text).toBeFalsy();
    const steps = await run(
      Effect.flatMap(Db, (db) =>
        db.select().from(documentSteps).where(eq(documentSteps.documentId, documentId)),
      ),
    );
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((step) => step.origin === "user" && step.clientId === "app:client-1")).toBe(
      true,
    );

    // The first block changed since that read: the same seen no longer covers it.
    const stale = await call(client, "edit_document", {
      documentId,
      seen,
      target: first,
      content: "Overwrite.",
    });
    expect(stale.isError).toBe(true);
    const forged = await call(client, "edit_document", { documentId, seen: "x", target: first });
    expect(forged.isError).toBe(true);
    const again = await call(client, "read_document", { documentId });
    expect(again.content[0]?.text).toContain("Better idea.");
    expect(again.content[0]?.text).not.toContain("Overwrite.");

    const stranger = await connect(await makeUser(), ["documents:read", "documents:write"]);
    expect((await call(stranger, "read_document", { documentId })).isError).toBe(true);
    expect(
      (
        await call(stranger, "create_document", {
          projectId: project.id,
          title: "X",
          content: "x",
        })
      ).isError,
    ).toBe(true);
    await stranger.close();
    await client.close();
  });

  it("reads a long document in pieces, a block longer than one piece included", async () => {
    const userId = await makeUser();
    const project = await run(
      Effect.flatMap(ProjectService, (projects) =>
        projects.create(userId, { name: "Long", instructions: "" }),
      ),
    );
    const client = await connect(userId, ["documents:read", "documents:write"]);
    const long = `${"word ".repeat(7000)}END`;
    const created = await call(client, "create_document", {
      projectId: project.id,
      title: "Long",
      content: `Opening line.\n\n${long}\n\nAfter the long one.`,
    });
    const documentId = created.structuredContent?.["documentId"] as string;
    type Piece = {
      xml: string;
      seen: string;
      next: { fromBlock: string; fromCharacter?: number } | null;
    };
    let piece = (await call(client, "read_document", { documentId })).structuredContent as Piece;
    const first = /id="([^"]+)"/.exec(piece.xml)![1]!;
    let text = piece.xml;
    for (let reads = 0; piece.next && reads < 5; reads++) {
      piece = (
        await call(client, "read_document", {
          documentId,
          fromBlock: piece.next.fromBlock,
          ...(piece.next.fromCharacter !== undefined
            ? { fromCharacter: piece.next.fromCharacter }
            : {}),
          seen: piece.seen,
        })
      ).structuredContent as Piece;
      text += piece.xml;
    }
    expect(piece.next).toBeNull();
    expect(text).toContain("END");
    expect(text).toContain("After the long one.");
    // The last piece's seen still covers the block only the first one showed.
    expect(piece.xml).not.toContain(`id="${first}"`);
    const edited = await call(client, "edit_document", {
      documentId,
      seen: piece.seen,
      target: first,
      content: "A new opening.",
    });
    expect(edited.isError, edited.content[0]?.text).toBeFalsy();
    // A block longer than one piece is never seen whole, so only find changes it.
    const whole = await call(client, "edit_document", {
      documentId,
      seen: piece.seen,
      target: /<part of="([^"]+)"/.exec(text)![1]!,
      content: "Short now.",
    });
    expect(whole.isError).toBe(true);
    const found = await call(client, "edit_document", {
      documentId,
      seen: piece.seen,
      find: "END",
      content: "FIN",
    });
    expect(found.isError, found.content[0]?.text).toBeFalsy();
    await client.close();
  });
});
