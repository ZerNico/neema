import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";
import { Prompt, Response, Tool } from "effect/unstable/ai";
import type { ChatStreamPart } from "./gateway.ts";
import {
  hermesToolCalls,
  needsHermesTools,
  renderHermesSystemBlock,
  rewriteHermesPrompt,
} from "./hermes-tools.ts";

const webSearch = Tool.make("web_search", {
  description: "Search the web",
  parameters: Schema.Struct({ queries: Schema.Array(Schema.String) }),
});
const readUrl = Tool.make("read_url", {
  description: "Read pages",
  parameters: Schema.Struct({ urls: Schema.Array(Schema.String) }),
});
const tools = [webSearch, readUrl];

let ids = 0;
const run = (parts: ChatStreamPart[]) =>
  Effect.map(
    Stream.runCollect(
      hermesToolCalls(Stream.fromIterable(parts), {
        tools,
        nextId: Effect.sync(() => `call_${++ids}`),
      }),
    ),
    (chunks) => Array.from(chunks),
  );

const text = (delta: string, metadata?: Response.TextDeltaPartMetadata): ChatStreamPart =>
  Response.makePart("text-delta", { id: "t1", delta, ...(metadata ? { metadata } : {}) });
const usage = new Response.Usage({ inputTokens: {}, outputTokens: {} });
const finish = (reason: Response.FinishReason = "stop"): ChatStreamPart =>
  Response.makePart("finish", { reason, usage });

const joinedText = (parts: ChatStreamPart[]) =>
  parts.map((p) => (p.type === "text-delta" ? p.delta : "")).join("");
const calls = (parts: ChatStreamPart[]) =>
  parts.flatMap((p) => (p.type === "tool-call" ? [{ name: p.name, params: p.params }] : []));
const finishReason = (parts: ChatStreamPart[]) => parts.find((p) => p.type === "finish")?.reason;

const call = (name: string, args: unknown) =>
  `<tool_call>\n${JSON.stringify({ name, arguments: args })}\n</tool_call>`;

describe("hermesToolCalls", () => {
  it.effect("turns a tool_call block into tool-call parts and a tool-calls finish", () =>
    Effect.gen(function* () {
      const out = yield* run([text(call("web_search", { queries: ["effect 4"] })), finish()]);
      expect(calls(out)).toEqual([{ name: "web_search", params: { queries: ["effect 4"] } }]);
      expect(out.map((p) => p.type)).toEqual([
        "tool-params-start",
        "tool-params-delta",
        "tool-params-end",
        "tool-call",
        "finish",
      ]);
      expect(finishReason(out)).toBe("tool-calls");
      expect(joinedText(out)).toBe("");
    }),
  );

  it.effect("handles tags and JSON split across chunk boundaries", () =>
    Effect.gen(function* () {
      const whole = `Looking it up. ${call("read_url", { urls: ["https://a.test"] })}`;
      const chunks = [];
      for (let i = 0; i < whole.length; i += 3) chunks.push(text(whole.slice(i, i + 3)));
      const out = yield* run([...chunks, finish()]);
      expect(joinedText(out)).toBe("Looking it up. ");
      expect(calls(out)).toEqual([{ name: "read_url", params: { urls: ["https://a.test"] } }]);
      expect(finishReason(out)).toBe("tool-calls");
    }),
  );

  it.effect("emits two calls from one turn with distinct ids", () =>
    Effect.gen(function* () {
      const out = yield* run([
        text(`${call("web_search", { queries: ["a"] })}\n${call("read_url", { urls: ["u"] })}`),
        finish(),
      ]);
      expect(calls(out).map((c) => c.name)).toEqual(["web_search", "read_url"]);
      const callIds = out.flatMap((p) => (p.type === "tool-call" ? [p.id] : []));
      expect(new Set(callIds).size).toBe(2);
      // The newline between blocks is ordinary text.
      expect(joinedText(out)).toBe("\n");
    }),
  );

  it.effect("keeps text before and after a call with the source part's metadata", () =>
    Effect.gen(function* () {
      const metadata = { openrouter: { note: "keep me" } };
      const out = yield* run([
        text(`Before ${call("web_search", { queries: ["x"] })} after`, metadata),
        finish(),
      ]);
      expect(joinedText(out)).toBe("Before  after");
      for (const part of out) {
        expect(part.metadata).toBeDefined();
        if (part.type === "text-delta") expect(part.metadata).toEqual(metadata);
      }
    }),
  );

  it.effect("treats a fenced example of the format as literal text", () =>
    Effect.gen(function* () {
      const fenced = `Write it like this:\n\`\`\`\n${call("web_search", { queries: ["q"] })}\n\`\`\`\nDone.`;
      const out = yield* run([text(fenced.slice(0, 30)), text(fenced.slice(30)), finish()]);
      expect(calls(out)).toEqual([]);
      expect(joinedText(out)).toBe(fenced);
      expect(finishReason(out)).toBe("stop");
    }),
  );

  it.effect("re-emits malformed JSON as text and leaves the finish reason alone", () =>
    Effect.gen(function* () {
      const raw = "<tool_call>\n{not json\n</tool_call>";
      const out = yield* run([text(raw), finish()]);
      expect(calls(out)).toEqual([]);
      expect(joinedText(out)).toBe(raw);
      expect(finishReason(out)).toBe("stop");
    }),
  );

  it.effect("re-emits a call to a tool that was not offered as text", () =>
    Effect.gen(function* () {
      const raw = call("delete_everything", {});
      const out = yield* run([text(raw), finish()]);
      expect(calls(out)).toEqual([]);
      expect(joinedText(out)).toBe(raw);
      expect(finishReason(out)).toBe("stop");
    }),
  );

  it.effect("accepts arguments serialized as a JSON string", () =>
    Effect.gen(function* () {
      const out = yield* run([
        text(
          `<tool_call>${JSON.stringify({ name: "web_search", arguments: '{"queries":["s"]}' })}</tool_call>`,
        ),
        finish(),
      ]);
      expect(calls(out)).toEqual([{ name: "web_search", params: { queries: ["s"] } }]);
    }),
  );

  it.effect("flushes an unterminated block as text at stream end", () =>
    Effect.gen(function* () {
      const out = yield* run([text('<tool_call>{"name": "web_se'), finish()]);
      expect(calls(out)).toEqual([]);
      expect(joinedText(out)).toBe('<tool_call>{"name": "web_se');
      expect(finishReason(out)).toBe("stop");
    }),
  );

  it.effect("flushes a held-back partial marker before a non-text part", () =>
    Effect.gen(function* () {
      const out = yield* run([text("Done <tool"), Response.makePart("text-end", { id: "t1" })]);
      expect(out.map((p) => p.type)).toEqual(["text-delta", "text-delta", "text-end"]);
      expect(joinedText(out)).toBe("Done <tool");
    }),
  );

  it.effect("produces a turn that folds back into a prompt", () =>
    Effect.gen(function* () {
      const out = yield* run([
        Response.makePart("text-start", { id: "t1" }),
        text(`Let me look. ${call("web_search", { queries: ["q"] })}`),
        Response.makePart("text-end", { id: "t1" }),
        finish(),
      ]);
      const prompt = Prompt.fromResponseParts(out);
      const assistant = prompt.content.find((m) => m.role === "assistant");
      // Text closes at `text-end`, after the call, exactly as a native
      // adapter's stream folds.
      expect(new Set(assistant?.content.map((p) => p.type))).toEqual(
        new Set(["text", "tool-call"]),
      );
      expect(JSON.stringify(assistant)).not.toContain("<tool_call>");
    }),
  );
});

describe("needsHermesTools", () => {
  it("is a no-op without tools or with toolChoice none", () => {
    expect(needsHermesTools({ tools: [], toolChoice: "auto" })).toBe(false);
    expect(needsHermesTools({ tools, toolChoice: "none" })).toBe(false);
    expect(needsHermesTools({ tools, toolChoice: "auto" })).toBe(true);
    expect(needsHermesTools({ tools, toolChoice: "required" })).toBe(true);
  });
});

const system = (prompt: Prompt.Prompt) =>
  prompt.content.flatMap((m) => (m.role === "system" ? [m.content] : []));

describe("rewriteHermesPrompt", () => {
  it("appends the tool signatures after the app's own system prompt", () => {
    const rewritten = rewriteHermesPrompt({
      prompt: Prompt.make([
        { role: "system", content: "Stable policy" },
        { role: "user", content: "Hi" },
      ]),
      tools,
    });
    const [block] = system(rewritten);
    expect(system(rewritten)).toHaveLength(1);
    expect(block?.startsWith("Stable policy\n\n")).toBe(true);
    expect(block).toContain("<tools>");
    expect(block).toContain(JSON.stringify(Tool.getJsonSchema(webSearch)));
    expect(block).toContain('"description":"Search the web"');
    expect(block).toContain("<tool_call>");
    expect(rewritten.content.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("creates a system message when there is none", () => {
    const rewritten = rewriteHermesPrompt({ prompt: Prompt.make("Hi"), tools });
    expect(rewritten.content.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("strengthens the instruction for a required tool choice", () => {
    expect(renderHermesSystemBlock(tools, "required")).toContain("must call at least one");
    expect(renderHermesSystemBlock(tools, { tool: "read_url" })).toContain('"read_url"');
    expect(renderHermesSystemBlock(tools, "auto")).not.toContain("must call");
  });

  it("rewrites assistant tool calls and tool results as Hermes text", () => {
    const prompt = Prompt.make([
      { role: "user", content: "Search" },
      Prompt.makeMessage("assistant", {
        content: [
          Prompt.makePart("text", { text: "Sure." }),
          Prompt.makePart("tool-call", {
            id: "c1",
            name: "web_search",
            params: { queries: ["q"] },
            providerExecuted: false,
          }),
        ],
      }),
      Prompt.makeMessage("tool", {
        content: [
          Prompt.makePart("tool-result", {
            id: "c1",
            name: "web_search",
            isFailure: false,
            result: { ok: true },
            providerExecuted: false,
          }),
        ],
      }),
    ]);
    const rewritten = rewriteHermesPrompt({ prompt, tools });
    expect(rewritten.content.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    const parts = (index: number) => {
      const content = rewritten.content[index]!.content;
      return typeof content === "string" ? [] : content;
    };
    expect(parts(2).map((p) => p.type)).toEqual(["text", "text"]);
    const assistantText = parts(2)
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("");
    expect(assistantText).toBe(
      `Sure.\n<tool_call>\n${JSON.stringify({ name: "web_search", arguments: { queries: ["q"] } })}\n</tool_call>`,
    );
    const response = parts(3)[0]!;
    expect(response.type === "text" && response.text).toBe(
      `<tool_response>\n${JSON.stringify({ name: "web_search", id: "c1", content: { ok: true } })}\n</tool_response>`,
    );
    for (let index = 0; index < rewritten.content.length; index++)
      for (const part of parts(index))
        expect(part.type === "tool-call" || part.type === "tool-result").toBe(false);
  });
});
