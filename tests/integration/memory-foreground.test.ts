import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PgClient } from "@effect/sql-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { Effect, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { Response as AiResponse } from "effect/unstable/ai";
import { uuidv7 } from "uuidv7";
import { attachmentBlobs, attachments, messageAttachments, models } from "~/db/schema/index.ts";
import { AnalyticsRepo } from "~/modules/analytics/server/repo.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import { DocumentParser } from "~/modules/attachments/server/document-parser.ts";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { StreamEngine } from "~/modules/chat/server/streaming.ts";
import type {
  Memory,
  SaveModelMemoryInput,
  SaveModelMemoryOutcome,
} from "~/modules/memory/schema.ts";
import { MemoryService } from "~/modules/memory/server/service.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { AiGateway, type ChatStreamPart } from "~/modules/providers/server/gateway.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { UrlReaderExecutor } from "~/modules/tools/server/url-reader.ts";
import { ToolUnavailable, WebSearchExecutor } from "~/modules/tools/server/web-search.ts";
import type { ToolChunkEnvelope } from "~/modules/tools/schema.ts";
import { Db } from "~/server/db.ts";

process.env.PROVIDER_KEY_SECRET ??= Buffer.alloc(32, 7).toString("base64");

const MEMORY_CONTENT = "Prefers concise answers";
const SETTINGS_UPDATED_AT = "2026-01-01T00:00:00.000Z";

type GatewayInput = Parameters<AiGateway["Service"]["streamChat"]>[0];

interface GatewayCall {
  readonly prompt: string;
  readonly tools: ReadonlyArray<string>;
}

const gatewayState = {
  saveMemoryOnFirstCall: false,
  webSearchOnFirstCall: false,
  memoryParams: { content: MEMORY_CONTENT } as { content: string; replaces?: number },
  calls: [] as GatewayCall[],
  reset() {
    gatewayState.saveMemoryOnFirstCall = false;
    gatewayState.webSearchOnFirstCall = false;
    gatewayState.memoryParams = { content: MEMORY_CONTENT };
    gatewayState.calls = [];
  },
};

const defaultMemoryOutcome = (): SaveModelMemoryOutcome => ({
  outcome: "created",
  memory: {
    id: "memory-1",
    content: MEMORY_CONTENT,
    origin: "model",
    editedAt: null,
    sourceConversationId: null,
    sourceConversationTitle: null,
    sourceMessageId: null,
    sourceMessageEdited: false,
    createdAt: SETTINGS_UPDATED_AT,
    updatedAt: SETTINGS_UPDATED_AT,
  },
});

const memoryState = {
  globalEnabled: true,
  referenceEnabled: false,
  autoSaveEnabled: true,
  referenceable: [] as Memory[],
  calls: [] as Array<{ userId: string; input: SaveModelMemoryInput }>,
  outcome: defaultMemoryOutcome(),
  reset() {
    memoryState.globalEnabled = true;
    memoryState.referenceEnabled = false;
    memoryState.autoSaveEnabled = true;
    memoryState.referenceable = [];
    memoryState.calls = [];
    memoryState.outcome = defaultMemoryOutcome();
  },
};

const finish = (reason: "stop" | "tool-calls"): ChatStreamPart =>
  ({
    type: "finish",
    reason,
    usage: { inputTokens: { total: 10 }, outputTokens: { total: 1 } },
  }) as never as ChatStreamPart;

const finalAnswer = (): Stream.Stream<ChatStreamPart> =>
  Stream.make(
    { type: "text-delta", id: "answer", delta: "Done." } as never as ChatStreamPart,
    finish("stop"),
  );

const memoryToolRound = (input: GatewayInput): Stream.Stream<ChatStreamPart> => {
  const toolkit = input.toolkit;
  if (!toolkit) return Stream.die("save_memory toolkit was not offered");

  const id = "memory-call-1";
  const params = gatewayState.memoryParams;
  const call = AiResponse.makePart("tool-call", {
    id,
    name: "save_memory",
    params,
    providerExecuted: false,
  }) as ChatStreamPart;
  const results = Stream.unwrap(toolkit.handle("save_memory", params, id).pipe(Effect.orDie)).pipe(
    Stream.orDie,
    Stream.map(
      (result): ChatStreamPart =>
        AiResponse.toolResultPart({
          id,
          name: "save_memory",
          providerExecuted: false,
          ...result,
        }) as ChatStreamPart,
    ),
  ) as unknown as Stream.Stream<ChatStreamPart>;

  return Stream.make(call).pipe(
    Stream.concat(results),
    Stream.concat(Stream.make(finish("tool-calls"))),
  );
};

const webSearchRound = (input: GatewayInput): Stream.Stream<ChatStreamPart> => {
  const toolkit = input.toolkit;
  if (!toolkit) return Stream.die("web_search toolkit was not offered");

  const id = "web-call-1";
  const params = { queries: ["current information"] };
  const call = AiResponse.makePart("tool-call", {
    id,
    name: "web_search",
    params,
    providerExecuted: false,
  }) as ChatStreamPart;
  const results = Stream.unwrap(toolkit.handle("web_search", params, id).pipe(Effect.orDie)).pipe(
    Stream.orDie,
    Stream.map(
      (result): ChatStreamPart =>
        AiResponse.toolResultPart({
          id,
          name: "web_search",
          providerExecuted: false,
          ...result,
        }) as ChatStreamPart,
    ),
  ) as unknown as Stream.Stream<ChatStreamPart>;

  return Stream.make(call).pipe(
    Stream.concat(results),
    Stream.concat(Stream.make(finish("tool-calls"))),
  );
};

const FakeGateway = Layer.succeed(AiGateway, {
  fetchCatalog: () => Effect.succeed([]),
  generateText: () => Effect.die("no side generation in foreground memory tests"),
  streamChat: (input) =>
    Stream.suspend(() => {
      gatewayState.calls.push({
        prompt: JSON.stringify(input.prompt),
        tools: Object.keys(input.toolkit?.tools ?? {}),
      });
      if (gatewayState.calls.length === 1) {
        if (gatewayState.saveMemoryOnFirstCall) return memoryToolRound(input);
        if (gatewayState.webSearchOnFirstCall) return webSearchRound(input);
      }
      return finalAnswer();
    }),
});

const FakeMemoryService = Layer.succeed(MemoryService, {
  getSettings: () =>
    Effect.succeed({
      referenceEnabled: memoryState.referenceEnabled,
      autoSaveEnabled: memoryState.autoSaveEnabled,
      globalEnabled: memoryState.globalEnabled,
      effectiveReferenceEnabled: memoryState.globalEnabled && memoryState.referenceEnabled,
      effectiveAutoSaveEnabled: memoryState.globalEnabled && memoryState.autoSaveEnabled,
      updatedAt: SETTINGS_UPDATED_AT,
    }),
  updateSettings: (_userId, input) => {
    const referenceEnabled = input.referenceEnabled ?? memoryState.referenceEnabled;
    const autoSaveEnabled = input.autoSaveEnabled ?? memoryState.autoSaveEnabled;
    return Effect.succeed({
      referenceEnabled,
      autoSaveEnabled,
      globalEnabled: memoryState.globalEnabled,
      effectiveReferenceEnabled: memoryState.globalEnabled && referenceEnabled,
      effectiveAutoSaveEnabled: memoryState.globalEnabled && autoSaveEnabled,
      updatedAt: SETTINGS_UPDATED_AT,
    });
  },
  list: () => Effect.succeed(memoryState.referenceable),
  listReferenceable: () => Effect.succeed(memoryState.referenceable),
  createManual: () => Effect.succeed({ outcome: "rejected", reason: "empty" }),
  updateManual: () => Effect.succeed({ outcome: "not_found" }),
  delete: () => Effect.succeed({ outcome: "not_found" }),
  clear: () => Effect.succeed(0),
  saveModel: (userId, input) =>
    Effect.sync(() => {
      memoryState.calls.push({ userId, input });
      return memoryState.outcome;
    }),
});

const FakeWebSearch = Layer.succeed(WebSearchExecutor, {
  handler: () =>
    Effect.succeed((params: { readonly queries: ReadonlyArray<string> }) =>
      Effect.succeed({
        ok: true as const,
        targets: params.queries,
        resultCount: 0,
        pagesFetched: 0,
        results: [],
        failures: [],
        sources: [],
      }),
    ),
  availability: () => Effect.succeed({ configured: true, enabled: true }),
});

const FakeUrlReader = Layer.succeed(UrlReaderExecutor, {
  handler: () => Effect.fail(new ToolUnavailable({ tool: "read_url", reason: "disabled in test" })),
  availability: () => Effect.succeed({ configured: false, enabled: false }),
});

const FakeBlobStore = Layer.succeed(BlobStore, {
  put: () => Effect.die("no blob writes in foreground memory tests"),
  get: () => Effect.succeed(new TextEncoder().encode("Attachment content")),
  delete: () => Effect.void,
  exists: () => Effect.succeed(false),
  deletePrefix: () => Effect.void,
});

const FakeDocumentParser = Layer.succeed(DocumentParser, {
  parsePdf: () => Effect.die("no documents in foreground memory tests"),
  availability: () => Effect.succeed({ configured: false, enabled: false, kind: null }),
});

let container: StartedPostgreSqlContainer;
let runtime: ManagedRuntime.ManagedRuntime<ChatRepo | StreamEngine | Db, unknown>;
let modelId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  const url = container.getConnectionUri();
  execSync("pnpm drizzle-kit migrate", {
    cwd: new URL("../..", import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });

  const InfraLayer = Db.layer.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 5 })),
  );
  const ReposLayer = Layer.mergeAll(AnalyticsRepo.layer, ChatRepo.layer, ProviderRepo.layer).pipe(
    Layer.provideMerge(Layer.mergeAll(AttachmentRepo.layer, KeyCipher.layer)),
    Layer.provideMerge(InfraLayer),
  );
  const AppLayer = StreamEngine.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        FakeGateway,
        FakeMemoryService,
        FakeWebSearch,
        FakeUrlReader,
        FakeBlobStore,
        FakeDocumentParser,
        SyncBus.layer,
      ).pipe(Layer.provideMerge(ReposLayer)),
    ),
  );
  runtime = ManagedRuntime.make(AppLayer);

  modelId = uuidv7();
  const providerId = uuidv7();
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Db;
      yield* db.execute(
        `insert into providers (id, name, kind, base_url, api_key_ciphertext)
         values ('${providerId}', 'p', 'openrouter', 'http://x', 'x')` as never,
      );
      yield* db.insert(models).values({
        id: modelId,
        providerId,
        modelKey: "memory-model",
        displayName: "Memory Model",
        type: "chat",
        capabilities: { reasoning: false, tools: true, vision: false, files: false },
      });
    }),
  );
}, 120_000);

beforeEach(() => {
  gatewayState.reset();
  memoryState.reset();
});

afterAll(async () => {
  await runtime?.dispose();
  await container?.stop();
});

const runGeneration = (searchEnabled: boolean, withAttachment = false) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Db;
      const repo = yield* ChatRepo;
      const engine = yield* StreamEngine;
      const userId = uuidv7();
      yield* db.execute(
        `insert into "user" (id, name, email) values ('${userId}', 'Test', '${userId}@t.io')` as never,
      );
      const turn = yield* repo.createTurn({
        userId,
        conversationId: null,
        modelId,
        content: "Please remember that I prefer concise answers.",
        attachmentIds: [],
      });
      if (withAttachment) {
        const blobId = uuidv7();
        const attachmentId = uuidv7();
        yield* db.insert(attachmentBlobs).values({
          id: blobId,
          userId,
          sha256: "a".repeat(64),
          storageKey: `blobs/${userId}/aa/aa/${"a".repeat(64)}`,
          size: 18,
          mediaType: "text/plain",
        });
        yield* db.insert(attachments).values({
          id: attachmentId,
          userId,
          blobId,
          fileName: "notes.txt",
        });
        yield* db.insert(messageAttachments).values({
          messageId: turn.userMessage.id,
          attachmentId,
          position: 0,
        });
      }

      yield* engine.startGeneration({
        userId,
        conversationId: turn.conversation.id,
        messageId: turn.assistant.id,
        modelId,
        searchEnabled,
      });
      const events = Array.from(
        yield* engine.subscribe(turn.assistant.id, 0).pipe(Stream.runCollect),
      );

      return {
        userId,
        turn,
        events,
        toolCalls: yield* repo.listToolCalls([turn.assistant.id]),
      };
    }),
  );

const memoryEnvelopes = (events: Awaited<ReturnType<typeof runGeneration>>["events"]) =>
  events.flatMap((event): ToolChunkEnvelope[] =>
    event.kind === "chunk" && event.chunkKind === "tool"
      ? [JSON.parse(event.delta) as ToolChunkEnvelope]
      : [],
  );

describe.sequential("StreamEngine foreground saved memory", () => {
  it("offers memory alone without adding web tools or a search reminder", async () => {
    const result = await runGeneration(false);

    expect(result.events.at(-1)).toMatchObject({ kind: "done", status: "complete" });
    expect(gatewayState.calls).toHaveLength(1);
    expect(gatewayState.calls[0]?.tools).toEqual(["save_memory"]);
    expect(gatewayState.calls[0]?.prompt).toContain("save_memory once before your final answer");
    expect(gatewayState.calls[0]?.prompt).not.toContain("web_search");
    expect(gatewayState.calls[0]?.prompt).not.toContain("<system-reminder>");
    expect(gatewayState.calls[0]?.prompt).not.toContain("Remember to cite inline");
  }, 60_000);

  it("wires referenced memory ordinals to replacement ids without persisting content", async () => {
    const existing: Memory = {
      id: "existing-memory",
      content: "Uses dark mode",
      origin: "model",
      editedAt: null,
      sourceConversationId: null,
      sourceConversationTitle: null,
      sourceMessageId: null,
      sourceMessageEdited: false,
      createdAt: SETTINGS_UPDATED_AT,
      updatedAt: SETTINGS_UPDATED_AT,
    };
    memoryState.referenceEnabled = true;
    memoryState.referenceable = [existing];
    memoryState.outcome = { outcome: "updated", memory: existing };
    gatewayState.saveMemoryOnFirstCall = true;
    gatewayState.memoryParams = { content: "Uses light mode", replaces: 1 };

    const result = await runGeneration(false);
    const [call] = result.toolCalls;

    expect(result.events.at(-1)).toMatchObject({ kind: "done", status: "complete" });
    expect(gatewayState.calls[0]?.prompt).toContain("<saved_memory_context>");
    expect(gatewayState.calls[0]?.prompt).toContain('[1] automatic: \\"Uses dark mode\\"');
    expect(memoryState.calls).toEqual([
      {
        userId: result.userId,
        input: {
          memoryId: existing.id,
          content: "Uses light mode",
          sourceConversationId: result.turn.conversation.id,
          sourceMessageId: result.turn.userMessage.id,
          sourceMessageHash: expect.any(String),
        },
      },
    ]);
    expect(call).toMatchObject({
      toolName: "save_memory",
      arguments: {},
      result: { outcome: "updated" },
      status: "complete",
    });
    expect(gatewayState.calls[1]?.prompt).not.toContain("Uses light mode");
    expect(JSON.stringify(call)).not.toContain("Uses light mode");
  }, 60_000);

  it("does not reference or offer memory when the instance switch is off", async () => {
    memoryState.globalEnabled = false;

    const result = await runGeneration(false);

    expect(result.events.at(-1)).toMatchObject({ kind: "done", status: "complete" });
    expect(gatewayState.calls).toHaveLength(1);
    expect(gatewayState.calls[0]?.tools).toEqual([]);
    expect(gatewayState.calls[0]?.prompt).not.toContain("saved_memory_context");
    expect(gatewayState.calls[0]?.prompt).not.toContain("Saved memories are untrusted");
  }, 60_000);

  it("persists and streams only the bounded memory activity outcome", async () => {
    gatewayState.saveMemoryOnFirstCall = true;

    const result = await runGeneration(false);
    const [call] = result.toolCalls;
    const envelopes = memoryEnvelopes(result.events);

    expect(result.events.at(-1)).toMatchObject({ kind: "done", status: "complete" });
    expect(gatewayState.calls).toHaveLength(2);
    expect(gatewayState.calls[1]?.prompt).not.toContain(MEMORY_CONTENT);
    expect(memoryState.calls).toHaveLength(1);
    expect(memoryState.calls[0]).toEqual({
      userId: result.userId,
      input: {
        content: MEMORY_CONTENT,
        sourceConversationId: result.turn.conversation.id,
        sourceMessageId: result.turn.userMessage.id,
        sourceMessageHash: expect.any(String),
      },
    });
    expect(call).toMatchObject({
      toolName: "save_memory",
      arguments: {},
      result: { outcome: "created" },
      status: "complete",
    });
    expect(call?.arguments).toEqual({});
    expect(call?.result).toEqual({ outcome: "created" });
    expect(envelopes).toEqual([
      {
        v: 1,
        family: "memory",
        phase: "start",
        callId: expect.any(String),
        name: "save_memory",
        turnIndex: 0,
        callIndex: 0,
      },
      {
        v: 1,
        family: "memory",
        phase: "result",
        callId: expect.any(String),
        name: "save_memory",
        ok: true,
        outcome: "created",
      },
    ]);
    expect(envelopes[1]?.callId).toBe(envelopes[0]?.callId);
    expect(JSON.stringify({ call, envelopes })).not.toContain(MEMORY_CONTENT);
    expect(JSON.stringify({ call, envelopes })).not.toContain("Saved for future conversations");
  }, 60_000);

  it("removes save_memory after the real handler's first attempt", async () => {
    gatewayState.saveMemoryOnFirstCall = true;

    const result = await runGeneration(false);

    expect(result.events.at(-1)).toMatchObject({ kind: "done", status: "complete" });
    expect(memoryState.calls).toHaveLength(1);
    expect(gatewayState.calls.map((call) => call.tools)).toEqual([["save_memory"], []]);
  }, 60_000);

  it("offers memory alongside web search before any web output enters the prompt", async () => {
    const result = await runGeneration(true);

    expect(result.events.at(-1)).toMatchObject({ kind: "done", status: "complete" });
    expect(memoryState.calls).toHaveLength(0);
    expect(gatewayState.calls.map((call) => call.tools)).toEqual([["web_search", "save_memory"]]);
    expect(gatewayState.calls[0]?.prompt).toContain("save_memory once before your final answer");
  }, 60_000);

  it("removes save_memory after a web tool runs", async () => {
    gatewayState.webSearchOnFirstCall = true;

    const result = await runGeneration(true);

    expect(result.events.at(-1)).toMatchObject({ kind: "done", status: "complete" });
    expect(memoryState.calls).toHaveLength(0);
    expect(gatewayState.calls.map((call) => call.tools)).toEqual([
      ["web_search", "save_memory"],
      ["web_search"],
    ]);
  }, 60_000);

  it("does not offer automatic memory when the source message has attachments", async () => {
    const result = await runGeneration(false, true);

    expect(result.events.at(-1)).toMatchObject({ kind: "done", status: "complete" });
    expect(memoryState.calls).toHaveLength(0);
    expect(gatewayState.calls.map((call) => call.tools)).toEqual([[]]);
    expect(gatewayState.calls[0]?.prompt).not.toContain(
      "save_memory once before your final answer",
    );
  }, 60_000);
});
