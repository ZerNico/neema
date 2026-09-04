import { Effect, Schema } from "effect";
import { Tool } from "effect/unstable/ai";
import { describe, expect, it, vi } from "vitest";
import { MAX_MEMORY_CONTENT_LENGTH } from "../schema.ts";
import {
  prepareMemoryTool,
  SaveMemoryParams,
  saveMemoryTool,
  type SaveMemoryResult,
} from "./memory-tool.ts";
import type { MemoryService } from "./service.ts";

type Handler = (params: SaveMemoryParams) => Effect.Effect<SaveMemoryResult>;

const setup = (outcome: Parameters<typeof Effect.succeed>[0] = { outcome: "created" }) => {
  const saveModel = vi.fn(() => Effect.succeed(outcome as never));
  const group = prepareMemoryTool({
    memory: { saveModel } as unknown as MemoryService["Service"],
    userId: "user-1",
    conversationId: "conversation-1",
    sourceMessageId: "message-1",
    sourceMessageHash: "source-hash",
    ordinals: new Map([[1, "memory-1"]]),
  });
  return { saveModel, handler: group.group.handlers["save_memory"] as Handler };
};

describe("prepareMemoryTool", () => {
  it("adds a memory with trusted provenance", async () => {
    const { saveModel, handler } = setup({ outcome: "created" });

    await expect(
      Effect.runPromise(handler({ content: "Prefers concise answers" })),
    ).resolves.toEqual({
      ok: true,
      outcome: "created",
      message: "Saved for future conversations.",
    });
    expect(saveModel).toHaveBeenCalledWith("user-1", {
      content: "Prefers concise answers",
      sourceConversationId: "conversation-1",
      sourceMessageId: "message-1",
      sourceMessageHash: "source-hash",
    });
  });

  it("resolves replacement ordinals inside the trusted handler closure", async () => {
    const { saveModel, handler } = setup({ outcome: "updated" });

    await Effect.runPromise(handler({ content: "Now prefers detailed answers", replaces: 1 }));

    expect(saveModel).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        memoryId: "memory-1",
      }),
    );
  });

  it("rejects unknown ordinals without calling storage", async () => {
    const { saveModel, handler } = setup();

    await expect(
      Effect.runPromise(handler({ content: "A correction", replaces: 99 })),
    ).resolves.toMatchObject({ ok: false, outcome: "rejected" });
    expect(saveModel).not.toHaveBeenCalled();
  });

  it("allows at most one attempt for the whole assistant generation", async () => {
    const { saveModel, handler } = setup();

    await Effect.runPromise(handler({ content: "First" }));
    await expect(Effect.runPromise(handler({ content: "Second" }))).resolves.toEqual({
      ok: false,
      outcome: "rejected",
      message: "Only one memory save attempt is allowed per response.",
    });
    expect(saveModel).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["duplicate", "unchanged", true],
    ["limit_reached", "rejected", false],
    ["protected", "rejected", false],
    ["source_changed", "rejected", false],
    ["disabled", "rejected", false],
  ] as const)("maps %s to the bounded %s activity outcome", async (stored, visible, ok) => {
    const { handler } = setup({ outcome: stored });

    await expect(Effect.runPromise(handler({ content: "Remember this" }))).resolves.toMatchObject({
      ok,
      outcome: visible,
    });
  });

  it("turns persistence defects into a tool result instead of failing chat", async () => {
    const saveModel = vi.fn(() => Effect.die("database unavailable"));
    const group = prepareMemoryTool({
      memory: { saveModel } as unknown as MemoryService["Service"],
      userId: "user-1",
      conversationId: "conversation-1",
      sourceMessageId: "message-1",
      sourceMessageHash: "source-hash",
      ordinals: new Map(),
    });

    await expect(
      Effect.runPromise(
        (group.group.handlers["save_memory"] as Handler)({ content: "Remember this" }),
      ),
    ).resolves.toEqual({
      ok: false,
      outcome: "rejected",
      message: "Memory could not be saved.",
    });
  });
});

describe("save_memory malformed parameters", () => {
  const decode = Schema.decodeUnknownEffect(SaveMemoryParams);
  const oversized = "x".repeat(MAX_MEMORY_CONTENT_LENGTH + 1);

  // A decode failure is raised before the handler runs and aborts the whole
  // generation, so the transport shape has to accept whatever the model emits.
  it.each([
    ["missing content", {}],
    ["non-string content", { content: 42 }],
    ["null content", { content: null }],
    ["structured content", { content: { text: "hi" } }],
    ["oversized content", { content: oversized }],
    ["string replaces", { content: "ok", replaces: "1" }],
    ["fractional replaces", { content: "ok", replaces: 1.5 }],
    ["zero replaces", { content: "ok", replaces: 0 }],
    ["null replaces", { content: "ok", replaces: null }],
    ["unknown extra key", { content: "ok", note: "chatty" }],
  ])("decodes %s instead of failing the generation", async (_label, params) => {
    await expect(Effect.runPromise(decode(params))).resolves.toBeDefined();
  });

  it("keeps the strict contract in the provider-facing JSON schema", () => {
    expect(Tool.getJsonSchema(saveMemoryTool)).toMatchObject({
      type: "object",
      properties: {
        content: {
          type: "string",
          minLength: 1,
          maxLength: MAX_MEMORY_CONTENT_LENGTH,
          description: expect.stringContaining("Required."),
        },
        replaces: {
          type: "integer",
          minimum: 1,
          description: expect.stringContaining("Optional."),
        },
      },
    });
  });

  it.each([
    ["missing content", {}],
    ["non-string content", { content: 42 }],
    ["blank content", { content: "   " }],
    ["oversized content", { content: oversized }],
    ["string replaces", { content: "Remember this", replaces: "1" }],
    ["fractional replaces", { content: "Remember this", replaces: 1.5 }],
    ["zero replaces", { content: "Remember this", replaces: 0 }],
  ])("rejects %s without touching storage", async (_label, params) => {
    const { saveModel, handler } = setup();

    const result = await Effect.runPromise(handler(params));

    expect(result).toMatchObject({ ok: false, outcome: "rejected" });
    expect(saveModel).not.toHaveBeenCalled();
  });

  it("keeps rejection messages bounded and free of the model's arguments", async () => {
    const { handler } = setup();
    const shouted = "SECRET-".repeat(5_000);

    const result = await Effect.runPromise(handler({ content: shouted, replaces: "nope" }));

    expect(result.message).not.toContain("SECRET-");
    expect(result.message.length).toBeLessThan(200);
  });

  it("treats a null replaces as a plain save", async () => {
    const { saveModel, handler } = setup({ outcome: "created" });

    await expect(
      Effect.runPromise(handler({ content: "Prefers concise answers", replaces: null })),
    ).resolves.toMatchObject({ ok: true, outcome: "created" });
    expect(saveModel).toHaveBeenCalledWith(
      "user-1",
      expect.not.objectContaining({ memoryId: expect.anything() }),
    );
  });

  it("spends the single attempt even when the arguments are malformed", async () => {
    const { saveModel, handler } = setup({ outcome: "created" });

    await expect(Effect.runPromise(handler({}))).resolves.toMatchObject({ outcome: "rejected" });
    await expect(Effect.runPromise(handler({ content: "Second try" }))).resolves.toEqual({
      ok: false,
      outcome: "rejected",
      message: "Only one memory save attempt is allowed per response.",
    });
    expect(saveModel).not.toHaveBeenCalled();
  });
});
