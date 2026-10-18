import { EmptyWebSearch } from "./unused-services.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { Response as AiResponse } from "effect/unstable/ai";
import { uuidv7 } from "uuidv7";
import { eq } from "drizzle-orm";
import {
  attachmentBlobs,
  attachments,
  messageAttachments,
  models,
  skillFiles,
  skillRevisions,
  skills,
  usageEvents,
} from "~/db/schema/index.ts";
import { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import { ChatRepo, PLAIN_GENERATION } from "~/modules/chat/server/repo.ts";
import { resolveAttemptSkills } from "~/modules/chat/server/effective-config.ts";
import { StreamEngine, type StreamEvent } from "~/modules/chat/server/streaming.ts";
import type {
  Memory,
  SaveModelMemoryInput,
  SaveModelMemoryOutcome,
} from "~/modules/memory/schema.ts";
import { MemoryService } from "~/modules/memory/server/service.ts";
import { AiGateway, type ChatStreamPart } from "~/modules/providers/server/gateway.ts";
import type { ToolChunkEnvelope } from "~/modules/tools/schema.ts";
import { Db, type DbTx } from "~/server/db.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";
import { engineLayer } from "./engine-harness.ts";

process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

const MEMORY_CONTENT = "Prefers concise answers";
const SETTINGS_UPDATED_AT = "2026-01-01T00:00:00.000Z";
const DOCUMENT_TOOLS = [
  "create_document",
  "edit_document",
  "read_chat_document",
  "list_chat_documents",
  "comment_on_document",
] as const;

type GatewayInput = Parameters<AiGateway["Service"]["streamChat"]>[0];

interface GatewayCall {
  readonly prompt: string;
  readonly tools: ReadonlyArray<string>;
}

const questionParams = {
  questions: [
    {
      question: "Which level of detail?",
      options: [{ label: "Concise" }, { label: "Detailed", description: "Include examples" }],
      multiSelect: false,
    },
  ],
};

const gatewayState = {
  askOnFirstCall: false,
  interleavedQuestionText: false,
  failAfterQuestion: false,
  duplicateQuestion: false,
  saveMemoryOnFirstCall: false,
  webSearchOnFirstCall: false,
  saveMemoryAfterWebSearch: false,
  memoryParams: { content: MEMORY_CONTENT } as { content: string; replaces?: number },
  calls: [] as GatewayCall[],
  reset() {
    gatewayState.askOnFirstCall = false;
    gatewayState.interleavedQuestionText = false;
    gatewayState.failAfterQuestion = false;
    gatewayState.duplicateQuestion = false;
    gatewayState.saveMemoryOnFirstCall = false;
    gatewayState.webSearchOnFirstCall = false;
    gatewayState.saveMemoryAfterWebSearch = false;
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
  }) as ChatStreamPart;

const finalAnswer = (): Stream.Stream<ChatStreamPart> =>
  Stream.make(
    { type: "text-delta", id: "answer", delta: "Done." } as ChatStreamPart,
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
  ) as Stream.Stream<ChatStreamPart>;

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
  ) as Stream.Stream<ChatStreamPart>;

  return Stream.make(call).pipe(
    Stream.concat(results),
    Stream.concat(Stream.make(finish("tool-calls"))),
  );
};

const questionRound = (input: GatewayInput, id: string): Stream.Stream<ChatStreamPart> => {
  if (!input.toolkit) return Stream.die("ask_user toolkit missing");
  const call = AiResponse.makePart("tool-call", {
    id,
    name: "ask_user",
    params: questionParams,
    providerExecuted: false,
  }) as ChatStreamPart;
  const results = Stream.unwrap(
    input.toolkit.handle("ask_user", questionParams, id).pipe(Effect.orDie),
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
  return Stream.make(call).pipe(Stream.concat(results));
};

const gateway = {
  generateText: () => Effect.die("no side generation in foreground memory tests"),
  streamChat: (input) =>
    Stream.suspend(() => {
      gatewayState.calls.push({
        prompt: JSON.stringify(input.prompt),
        // Draft tools, load_tools, create_file and read_attachment are always in
        // the toolkit, and the bundled authoring skills always appear in the
        // ambient catalogue; these suites assert the memory and question
        // toolkit, so filter those constants out.
        tools: Object.keys(input.toolkit?.tools ?? {}).filter(
          (name) =>
            !name.endsWith("agent_draft") &&
            !name.endsWith("schedule_draft") &&
            name !== "draft_agent" &&
            name !== "draft_schedule" &&
            name !== "list_agent_options" &&
            name !== "load_skill" &&
            name !== "load_tools" &&
            name !== "create_file" &&
            name !== "read_attachment" &&
            name !== "read_skill_file",
        ),
      });
      if (gatewayState.calls.length === 1) {
        if (gatewayState.askOnFirstCall)
          return (
            gatewayState.interleavedQuestionText
              ? Stream.make({
                  type: "text-delta",
                  id: "intro",
                  delta: "Before 🌍\n\n",
                } as ChatStreamPart)
              : Stream.empty
          ).pipe(
            Stream.concat(questionRound(input, "ask-1")),
            Stream.concat(
              gatewayState.interleavedQuestionText
                ? Stream.make({
                    type: "text-delta",
                    id: "between",
                    delta: "Between tools.\n\n",
                  } as ChatStreamPart)
                : Stream.empty,
            ),
            Stream.concat(
              gatewayState.duplicateQuestion ? questionRound(input, "ask-2") : Stream.empty,
            ),
            Stream.concat(
              gatewayState.saveMemoryOnFirstCall
                ? memoryToolRound(input).pipe(Stream.filter((part) => part.type !== "finish"))
                : Stream.empty,
            ),
            Stream.concat(
              gatewayState.interleavedQuestionText
                ? Stream.make({
                    type: "text-delta",
                    id: "trailing",
                    delta: "After both.",
                  } as ChatStreamPart)
                : Stream.empty,
            ),
            Stream.concat(
              gatewayState.failAfterQuestion
                ? Stream.die("simulated provider failure after question")
                : Stream.make(finish("tool-calls")),
            ),
          );
        if (gatewayState.saveMemoryOnFirstCall) return memoryToolRound(input);
        if (gatewayState.webSearchOnFirstCall) return webSearchRound(input);
      }
      if (gatewayState.calls.length === 2 && gatewayState.saveMemoryAfterWebSearch)
        return memoryToolRound(input);
      return finalAnswer();
    }),
} satisfies Partial<AiGateway["Service"]>;

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

const FakeBlobStore = Layer.succeed(BlobStore, {
  put: () => Effect.die("no blob writes in foreground memory tests"),
  get: () => Effect.succeed(new TextEncoder().encode("Attachment content")),
  delete: () => Effect.void,
  exists: () => Effect.succeed(false),
  deletePrefix: () => Effect.void,
});

let database: TestDatabase;
let runtime: ManagedRuntime.ManagedRuntime<ChatRepo | StreamEngine | Db, unknown>;
let modelId: string;

beforeAll(async () => {
  database = await createTestDatabase();
  const url = database.url;

  runtime = ManagedRuntime.make(
    engineLayer(url, {
      gateway,
      services: Layer.mergeAll(FakeMemoryService, EmptyWebSearch, FakeBlobStore),
    }),
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
        modelKey: "memory-model",
        displayName: "Memory Model",
        type: "chat",
        capabilities: {
          imageOutput: false,
          reasoning: false,
          tools: true,
          vision: false,
          files: false,
        },
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
  await database?.drop();
});

/** sha256 and length of the bytes FakeBlobStore hands back for every key. */
const SKILL_BLOB_SHA = "3f82ec854f554e1e5a7fed249f8a258289bca7ea378c737c55df5d04fa777196";
const SKILL_BLOB_BYTES = 18;

const runGeneration = (searchEnabled: boolean, withAttachment = false, withSkill = false) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Db;
      const repo = yield* ChatRepo;
      const engine = yield* StreamEngine;
      const userId = uuidv7();
      yield* db.execute(
        `insert into "user" (id, name, email) values ('${userId}', 'Test', '${userId}@t.io')` as never,
      );
      yield* db.execute(
        `insert into user_approvals (user_id, status) values ('${userId}', 'approved')` as never,
      );
      // Rows rather than SkillService: this suite only needs a resolvable
      // revision so the attempt carries a real skill selection.
      const skillId = uuidv7();
      if (withSkill) {
        const revisionId = uuidv7();
        const skillBlobId = uuidv7();
        yield* db.insert(skills).values({
          id: skillId,
          userId,
          name: "review",
          description: "Review carefully",
          revision: 1,
        });
        yield* db.insert(skillRevisions).values({
          id: revisionId,
          skillId,
          revision: 1,
          name: "review",
          description: "Review carefully",
          manualOnly: false,
          contentHash: "b".repeat(64),
        });
        // The fake store answers every key with the same bytes; stored files
        // are integrity-checked on read, so the digest has to be theirs.
        yield* db.insert(attachmentBlobs).values({
          id: skillBlobId,
          userId,
          sha256: SKILL_BLOB_SHA,
          storageKey: `blobs/${userId}/3f/82/${SKILL_BLOB_SHA}`,
          size: SKILL_BLOB_BYTES,
          mediaType: "text/markdown",
        });
        yield* db.insert(skillFiles).values({
          revisionId,
          path: "SKILL.md",
          blobId: skillBlobId,
          byteSize: SKILL_BLOB_BYTES,
          sha256: SKILL_BLOB_SHA,
        });
      }
      const turn = yield* repo.createTurn({
        userId,
        conversation: { kind: "new", id: uuidv7(), mode: "chat" },
        modelId,
        content: "Please remember that I prefer concise answers.",
        attachmentIds: [],
        // The selection has to reach the persisted generation config; passing
        // skillIds alone leaves `config.skills` empty and the attempt would
        // only ever see the skill as an ambient library offer.
        ...(withSkill
          ? {
              skillIds: [skillId],
              resolve: (tx: DbTx) =>
                resolveAttemptSkills(tx, userId, [skillId], []).pipe(
                  Effect.map((resolved) => ({ ...PLAIN_GENERATION, skills: resolved })),
                ),
            }
          : {}),
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
          mediaType: "text/plain",
        });
        yield* db.insert(messageAttachments).values({
          messageId: turn.userMessage.id,
          attachmentId,
          position: 0,
        });
      }

      yield* engine.startGeneration({
        generationId: turn.assistant.generationId ?? undefined,
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

const toolEnvelopes = (events: Awaited<ReturnType<typeof runGeneration>>["events"]) =>
  events.flatMap((event): ToolChunkEnvelope[] =>
    event.kind === "chunk" && event.chunkKind === "tool"
      ? [JSON.parse(event.delta) as ToolChunkEnvelope]
      : [],
  );

/** A replay reports when each chunk was written; otherwise it is the live stream. */
const withoutWriteTimes = (events: Iterable<StreamEvent>) =>
  Array.from(events, (event) => {
    if (event.kind !== "chunk") return event;
    const { at: _at, ...rest } = event;
    return rest;
  });
describe("StreamEngine durable clarification handoff", () => {
  it("finishes a tool-only question without another model call and replays its persisted result", async () => {
    gatewayState.askOnFirstCall = true;
    memoryState.globalEnabled = false;
    const result = await runGeneration(false);
    expect(gatewayState.calls).toHaveLength(1);
    expect(gatewayState.calls[0]?.tools).toEqual([...DOCUMENT_TOOLS, "ask_user"]);
    expect(memoryState.calls).toHaveLength(0);
    expect(result.events.at(-1)).toMatchObject({ kind: "done", status: "complete" });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      toolName: "ask_user",
      status: "complete",
      arguments: questionParams,
      result: { v: 1, outcome: "presented", ...questionParams },
    });
    const envelopes = toolEnvelopes(result.events);
    expect(envelopes).toEqual([
      {
        v: 1,
        family: "ask",
        phase: "start",
        callId: result.toolCalls[0]!.id,
        name: "ask_user",
        turnIndex: 0,
        callIndex: 0,
        textOffset: 0,
      },
      {
        v: 1,
        family: "ask",
        phase: "result",
        callId: result.toolCalls[0]!.id,
        name: "ask_user",
        result: { v: 1, outcome: "presented", ...questionParams },
      },
    ]);
    const stored = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const engine = yield* StreamEngine;
        const db = yield* Db;
        return {
          message: yield* repo.getMessage(result.turn.assistant.id),
          replay: withoutWriteTimes(
            yield* engine.subscribe(result.turn.assistant.id, 1).pipe(Stream.runCollect),
          ),
          ledger: yield* db
            .select()
            .from(usageEvents)
            .where(eq(usageEvents.messageId, result.turn.assistant.id))
            .pipe(Effect.orDie),
        };
      }),
    );
    expect(stored.message).toMatchObject({
      content: "",
      status: "complete",
      usage: { inputTokens: 10, outputTokens: 1 },
    });
    expect(stored.ledger).toHaveLength(1);
    expect(stored.replay).toEqual(
      result.events.filter(
        (event) => event.kind === "done" || (event.kind === "chunk" && event.seq > 1),
      ),
    );
    expect(result.events.flatMap((event) => (event.kind === "chunk" ? [event.seq] : []))).toEqual([
      1, 2,
    ]);
  });

  it("persists UTF-16 start anchors without dropping same-round text after the question", async () => {
    gatewayState.askOnFirstCall = true;
    gatewayState.saveMemoryOnFirstCall = true;
    gatewayState.interleavedQuestionText = true;
    const result = await runGeneration(false);
    const offsets = ["Before 🌍\n\n".length, "Before 🌍\n\nBetween tools.\n\n".length];
    expect(result.toolCalls.map((call) => call.textOffset)).toEqual(offsets);
    expect(
      toolEnvelopes(result.events)
        .filter((event) => event.phase === "start")
        .map((event) => event.textOffset),
    ).toEqual(offsets);
    const stored = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const engine = yield* StreamEngine;
        const message = yield* repo.getMessage(result.turn.assistant.id);
        const replay = withoutWriteTimes(
          yield* engine.subscribe(result.turn.assistant.id, 0).pipe(Stream.runCollect),
        );
        return { message, replay };
      }),
    );
    expect(stored.message).toMatchObject({
      status: "complete",
      content: "Before 🌍\n\nBetween tools.\n\nAfter both.",
    });
    expect(stored.replay).toEqual(result.events);
    expect(gatewayState.calls).toHaveLength(1);
  });

  it("settles sibling memory and duplicate questions before completing the handoff", async () => {
    gatewayState.askOnFirstCall = true;
    gatewayState.duplicateQuestion = true;
    gatewayState.saveMemoryOnFirstCall = true;
    const result = await runGeneration(false);
    expect(gatewayState.calls).toHaveLength(1);
    expect(result.events.at(-1)).toMatchObject({ status: "complete" });
    expect(result.toolCalls.map((call) => [call.toolName, call.status])).toEqual([
      ["ask_user", "complete"],
      ["ask_user", "error"],
      ["save_memory", "complete"],
    ]);
    expect(memoryState.calls).toHaveLength(1);
  });

  it("keeps a presented card unavailable when the asking response fails", async () => {
    gatewayState.askOnFirstCall = true;
    gatewayState.failAfterQuestion = true;
    const result = await runGeneration(false);
    expect(result.events.at(-1)).toMatchObject({ status: "error" });
    const answer = await runtime.runPromise(
      ChatRepo.use((repo) =>
        repo
          .createTurn({
            userId: result.userId,
            conversation: { kind: "existing", id: result.turn.conversation.id },
            modelId,
            attachmentIds: [],
            questionResponse: { callId: result.toolCalls[0]!.id, response: { kind: "skip" } },
          })
          .pipe(Effect.flip),
      ),
    );
    expect(answer).toMatchObject({ _tag: "QuestionUnavailable" });
  });

  it("projects question-only history in assistant role and keeps editable answers in their user turn", async () => {
    gatewayState.askOnFirstCall = true;
    const result = await runGeneration(false);
    const continued = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const engine = yield* StreamEngine;
        const turn = yield* repo.createTurn({
          userId: result.userId,
          conversation: { kind: "existing", id: result.turn.conversation.id },
          modelId,
          attachmentIds: [],
          questionResponse: {
            callId: result.toolCalls[0]!.id,
            response: { kind: "answers", answers: [{ selected: [1], custom: "" }] },
          },
        });
        yield* engine.startGeneration({
          generationId: turn.assistant.generationId ?? undefined,
          userId: result.userId,
          conversationId: turn.conversation.id,
          messageId: turn.assistant.id,
          modelId,
          searchEnabled: false,
        });
        yield* engine.subscribe(turn.assistant.id, 0).pipe(Stream.runCollect);
        return {
          turn,
          asking: yield* repo.getMessage(result.turn.assistant.id),
          calls: yield* repo.listToolCalls([result.turn.assistant.id]),
        };
      }),
    );
    expect(continued.turn.userMessage.content).toBe("Q1: Detailed");
    expect(continued.asking?.content).toBe("");
    expect(continued.calls).toEqual(result.toolCalls);
    const prompt = JSON.parse(gatewayState.calls[1]!.prompt) as {
      content: Array<{ role: string; content: unknown }>;
    };
    const question = prompt.content.find((message) =>
      JSON.stringify(message.content).includes("Which level of detail?"),
    );
    const answer = prompt.content.find((message) =>
      JSON.stringify(message.content).includes("Q1: Detailed"),
    );
    expect(question?.role).toBe("assistant");
    expect(JSON.stringify(question)).toContain("Detailed: Include examples");
    expect(answer?.role).toBe("user");
    expect(JSON.stringify(answer)).not.toContain("Which level of detail?");
    expect(gatewayState.calls[1]?.tools).not.toContain("read_url");
  });
});

describe("StreamEngine foreground saved memory", () => {
  it("offers memory and questions without adding web tools or a search reminder", async () => {
    const result = await runGeneration(false);

    expect(result.events.at(-1)).toMatchObject({ kind: "done", status: "complete" });
    expect(gatewayState.calls).toHaveLength(1);
    expect(gatewayState.calls[0]?.tools).toEqual([...DOCUMENT_TOOLS, "ask_user", "save_memory"]);
    expect(gatewayState.calls[0]?.prompt).toContain(
      "When the save_memory tool is available, call it once",
    );
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
    expect(gatewayState.calls[0]?.tools).toEqual([...DOCUMENT_TOOLS, "ask_user"]);
    expect(gatewayState.calls[0]?.prompt).not.toContain("saved_memory_context");
    expect(gatewayState.calls[0]?.prompt).not.toContain("Saved memories are untrusted");
  }, 60_000);

  it("persists and streams only the bounded memory activity outcome", async () => {
    gatewayState.saveMemoryOnFirstCall = true;

    const result = await runGeneration(false);
    const [call] = result.toolCalls;
    const envelopes = toolEnvelopes(result.events);

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
        textOffset: 0,
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

  it("persists and streams the fixed reason when a save is refused", async () => {
    gatewayState.saveMemoryOnFirstCall = true;
    memoryState.outcome = { outcome: "rejected", reason: "sensitive" };

    const result = await runGeneration(false);
    const [call] = result.toolCalls;
    const envelopes = toolEnvelopes(result.events);

    expect(result.events.at(-1)).toMatchObject({ kind: "done", status: "complete" });
    expect(call).toMatchObject({ toolName: "save_memory", status: "error", arguments: {} });
    expect(call?.result).toEqual({ outcome: "rejected", reason: "sensitive" });
    expect(envelopes[1]).toMatchObject({
      family: "memory",
      phase: "result",
      ok: false,
      outcome: "rejected",
      reason: "sensitive",
    });
    expect(JSON.stringify({ call, envelopes })).not.toContain(MEMORY_CONTENT);
    expect(JSON.stringify({ call, envelopes })).not.toContain("not safe to store");
  }, 60_000);

  it("removes save_memory after the real handler's first attempt", async () => {
    gatewayState.saveMemoryOnFirstCall = true;

    const result = await runGeneration(false);

    expect(result.events.at(-1)).toMatchObject({ kind: "done", status: "complete" });
    expect(memoryState.calls).toHaveLength(1);
    expect(gatewayState.calls.map((call) => call.tools)).toEqual([
      [...DOCUMENT_TOOLS, "ask_user", "save_memory"],
      [...DOCUMENT_TOOLS, "ask_user"],
    ]);
  }, 60_000);

  it("offers memory alongside web search", async () => {
    const result = await runGeneration(true);

    expect(result.events.at(-1)).toMatchObject({ kind: "done", status: "complete" });
    expect(memoryState.calls).toHaveLength(0);
    expect(gatewayState.calls.map((call) => call.tools)).toEqual([
      [...DOCUMENT_TOOLS, "web_search", "ask_user", "save_memory"],
    ]);
    expect(gatewayState.calls[0]?.prompt).toContain(
      "When the save_memory tool is available, call it once",
    );
  }, 60_000);

  it("saves memory after a web search and withdraws it only after its own attempt", async () => {
    gatewayState.webSearchOnFirstCall = true;
    gatewayState.saveMemoryAfterWebSearch = true;

    const result = await runGeneration(true);

    expect(result.events.at(-1)).toMatchObject({ kind: "done", status: "complete" });
    expect(memoryState.calls).toHaveLength(1);
    expect(memoryState.calls[0]?.input.content).toBe(MEMORY_CONTENT);
    expect(gatewayState.calls.map((call) => call.tools)).toEqual([
      [...DOCUMENT_TOOLS, "web_search", "ask_user", "save_memory"],
      [...DOCUMENT_TOOLS, "web_search", "ask_user", "save_memory"],
      [...DOCUMENT_TOOLS, "web_search", "ask_user"],
    ]);
  }, 60_000);

  it("keeps memory available when the attempt selects a skill", async () => {
    const result = await runGeneration(false, false, true);

    expect(result.events.at(-1)).toMatchObject({ kind: "done", status: "complete" });
    expect(gatewayState.calls[0]?.tools).toContain("save_memory");
    expect(gatewayState.calls[0]?.prompt).toContain(
      "When the save_memory tool is available, call it once",
    );
    // The skill is a real pinned selection, not merely an ambient offer: an
    // explicit entry has its root loaded into the prompt up front.
    expect(gatewayState.calls[0]?.prompt).toContain("<skill-guidance");
  }, 60_000);

  it("keeps memory available when the source message has attachments", async () => {
    const result = await runGeneration(false, true);

    expect(result.events.at(-1)).toMatchObject({ kind: "done", status: "complete" });
    expect(gatewayState.calls.map((call) => call.tools)).toEqual([
      [...DOCUMENT_TOOLS, "ask_user", "save_memory"],
    ]);
    expect(gatewayState.calls[0]?.prompt).toContain(
      "When the save_memory tool is available, call it once",
    );
  }, 60_000);
});

describe("StreamEngine temporary chats", () => {
  // Each attempt reads the flag from the conversation row, so Keep takes
  // effect on the next one without anything carried by the client.
  it("neither reads nor offers memory until the chat is kept", async () => {
    memoryState.referenceEnabled = true;
    memoryState.referenceable = [
      {
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
      },
    ];

    const turns = await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* Db;
        const repo = yield* ChatRepo;
        const engine = yield* StreamEngine;
        const userId = uuidv7();
        yield* db.execute(
          `insert into "user" (id, name, email) values ('${userId}', 'Test', '${userId}@t.io')` as never,
        );
        yield* db.execute(
          `insert into user_approvals (user_id, status) values ('${userId}', 'approved')` as never,
        );
        const answer = Effect.fn("test.answer")(function* (
          conversation: Parameters<typeof repo.createTurn>[0]["conversation"],
        ) {
          const turn = yield* repo.createTurn({
            userId,
            conversation,
            modelId,
            content: "Please remember that I prefer concise answers.",
            attachmentIds: [],
          });
          yield* engine.startGeneration({
            generationId: turn.assistant.generationId ?? undefined,
            userId,
            conversationId: turn.conversation.id,
            messageId: turn.assistant.id,
            modelId,
            searchEnabled: false,
          });
          const events = Array.from(
            yield* engine.subscribe(turn.assistant.id, 0).pipe(Stream.runCollect),
          );
          return { turn, done: events.at(-1) };
        });
        const temporary = yield* answer({
          kind: "new",
          id: uuidv7(),
          mode: "chat",
          temporary: true,
        });
        expect(yield* repo.keepConversation(userId, temporary.turn.conversation.id)).toBe(true);
        const kept = yield* answer({ kind: "existing", id: temporary.turn.conversation.id });
        return { temporary, kept };
      }),
    );

    expect(turns.temporary.done).toMatchObject({ kind: "done", status: "complete" });
    expect(turns.kept.done).toMatchObject({ kind: "done", status: "complete" });
    expect(gatewayState.calls).toHaveLength(2);
    expect(gatewayState.calls[0]?.tools).not.toContain("save_memory");
    expect(gatewayState.calls[0]?.prompt).not.toContain("Uses dark mode");
    expect(gatewayState.calls[0]?.prompt).not.toContain("save_memory");
    expect(gatewayState.calls[1]?.tools).toContain("save_memory");
    expect(gatewayState.calls[1]?.prompt).toContain("Uses dark mode");
  }, 60_000);
});
