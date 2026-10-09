import { DateTime, Effect, Encoding, type Schema, Stream } from "effect";
import { type AiError, IdGenerator, type LanguageModel, type Prompt } from "effect/unstable/ai";
import type { HttpClient } from "effect/unstable/http";
import {
  carryAssistantFiles,
  isRecord,
  jsonSchema,
  makeBlocks,
  markerBudget,
  parseArguments,
  replayMetadata,
  str,
  toolResultText,
  toolSchemas,
  toolSelection,
  type FinishReason,
  type StreamPart,
} from "./common.ts";
import {
  identityOf,
  postJson,
  responseBytes,
  type Connection,
  type ModelCall,
} from "./connection.ts";
import { configurationError, invalidOutput, networkError } from "./errors.ts";
import { checkCall } from "./policy.ts";
import { sameIdentity, unitsOfMessage, type ReplayUnit } from "./replay.ts";
import { sseEvents } from "./sse.ts";
import { normalizeUsage, unknownUsage } from "./usage.ts";

type Json = Record<string, unknown>;
type MessagesUnit = Extract<ReplayUnit, { format: "messages" }>;

/** `max_tokens` is required here; a call without a cap gets this one. */
export const DEFAULT_MAX_TOKENS = 32_000;

const CACHE = { cache_control: { type: "ephemeral" } } as const;

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** A prompt file as a source block: inline bytes, or the URL it already is. */
const source = (part: Prompt.FilePart): Json => {
  if (part.data instanceof URL) return { type: "url", url: part.data.toString() };
  if (typeof part.data === "string") {
    const match = /^data:([^;,]+)(?:;[^,]*)?,(.*)$/s.exec(part.data);
    if (match) return { type: "base64", media_type: match[1], data: match[2] };
    if (/^https?:\/\//.test(part.data)) return { type: "url", url: part.data };
    return { type: "base64", media_type: part.mediaType, data: part.data };
  }
  return { type: "base64", media_type: part.mediaType, data: Encoding.encodeBase64(part.data) };
};

const fileBlock = (part: Prompt.FilePart): Json | null => {
  if (part.mediaType.startsWith("image/")) return { type: "image", source: source(part) };
  if (part.mediaType === "application/pdf")
    return {
      type: "document",
      source: source(part),
      ...(part.fileName ? { title: part.fileName } : {}),
    };
  return null;
};

/** The API refuses empty text blocks. */
const textBlock = (text: string): Json[] => (text ? [{ type: "text", text }] : []);

const fileBlocks = (parts: ReadonlyArray<Prompt.FilePart>) =>
  parts.map(fileBlock).filter((block): block is Json => block !== null);

const userBlocks = (parts: ReadonlyArray<Prompt.UserMessagePart>) =>
  parts.flatMap((part) => (part.type === "text" ? textBlock(part.text) : fileBlocks([part])));

const marked = (blocks: Json[], mark: boolean) =>
  mark && blocks.length > 0
    ? blocks.map((block, index) => (index === blocks.length - 1 ? { ...block, ...CACHE } : block))
    : blocks;

const toolInput = (params: unknown) => {
  if (typeof params !== "string") return params ?? {};
  const parsed = parseArguments(params);
  return parsed.ok ? parsed.value : {};
};

const toolUse = (call: Prompt.ToolCallPart): Json => ({
  type: "tool_use",
  id: call.id,
  name: call.name,
  input: toolInput(call.params),
});

/**
 * An assistant turn. Signed thinking goes back in its place only while the
 * visible text is the text that was signed beside; after an edit the turn is
 * rebuilt from the prompt without it.
 */
const assistantBlocks = (message: Prompt.AssistantMessage, units: ReadonlyArray<MessagesUnit>) => {
  const calls = message.content.filter((part) => part.type === "tool-call");
  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  const stored = units.flatMap((unit) =>
    unit.blocks.flatMap((block) => (isRecord(block) ? [block] : [])),
  );
  const storedText = stored
    .filter((block) => block["type"] === "text")
    .map((block) => str(block["text"]) ?? "")
    .join("");
  const blocks: Json[] = [];
  const covered = new Set<string>();
  if (stored.length > 0 && storedText === text) {
    for (const block of stored) {
      if (block["type"] === "tool_use") {
        // An orphan call is a hard error: only calls the prompt still has.
        const call = calls.find((part) => part.id === str(block["id"]));
        if (!call) continue;
        covered.add(call.id);
        blocks.push(toolUse(call));
      } else if (block["type"] === "text") blocks.push(...textBlock(str(block["text"]) ?? ""));
      else blocks.push(block);
    }
  } else blocks.push(...textBlock(text));
  for (const call of calls) if (!covered.has(call.id)) blocks.push(toolUse(call));
  return blocks;
};

/** Roles must alternate: a tool result and the user's next words are one user turn. */
const alternate = (messages: ReadonlyArray<{ role: "user" | "assistant"; content: Json[] }>) => {
  const out: Array<{ role: "user" | "assistant"; content: Json[] }> = [];
  for (const message of messages) {
    if (message.content.length === 0) continue;
    const last = out.at(-1);
    if (last?.role === message.role) last.content = [...last.content, ...message.content];
    else out.push({ role: message.role, content: [...message.content] });
  }
  return out;
};

const toolChoiceOf = (choice: ReturnType<typeof toolSelection>["choice"]): Json | undefined => {
  if (choice === undefined) return undefined;
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  return { type: "tool", name: choice.name };
};

export const buildMessagesRequest = (
  connection: Connection,
  call: ModelCall,
  options: LanguageModel.ProviderOptions,
) =>
  Effect.gen(function* () {
    const identity = identityOf(connection, call.model);
    // Claude caches only where it is told to.
    const markers = markerBudget(options.prompt);
    const system: Json[] = [];
    const messages: Array<{ role: "user" | "assistant"; content: Json[] }> = [];
    const sent = new Set<string>();
    for (const message of carryAssistantFiles(options.prompt, false)) {
      switch (message.role) {
        case "carried":
          messages.push({
            role: "user",
            content: [
              { type: "text", text: "Files from the previous answer:" },
              ...fileBlocks(message.files),
            ],
          });
          break;
        case "system":
          // One system block for the request; the app keeps system text up front.
          system.push(...marked(textBlock(message.content), markers.has(message)));
          break;
        case "user":
          messages.push({
            role: "user",
            content: marked(userBlocks(message.content), markers.has(message)),
          });
          break;
        case "assistant": {
          const units = unitsOfMessage(message).filter(
            (unit): unit is MessagesUnit =>
              unit.format === "messages" &&
              sameIdentity(unit.identity, identity) &&
              !sent.has(unit.id),
          );
          for (const unit of units) sent.add(unit.id);
          messages.push({ role: "assistant", content: assistantBlocks(message, units) });
          break;
        }
        case "tool": {
          const results = message.content.filter((part) => part.type === "tool-result");
          messages.push({
            role: "user",
            content: marked(
              results.map((part) => ({
                type: "tool_result",
                tool_use_id: part.id,
                content: toolResultText(part.result),
                ...(part.isFailure ? { is_error: true } : {}),
              })),
              markers.has(message),
            ),
          });
          break;
        }
      }
    }

    const schemas = yield* toolSchemas(options);
    const selection = toolSelection(schemas, options.toolChoice);
    const choice = toolChoiceOf(selection.choice);
    const effort = call.reasoningEffort ?? undefined;
    const thinking = effort !== undefined && effort !== "none";
    if (thinking && (choice?.["type"] === "any" || choice?.["type"] === "tool"))
      return yield* Effect.fail(
        configurationError("Claude cannot reason while a tool is forced. Turn reasoning off."),
      );
    const format =
      options.responseFormat.type === "json"
        ? {
            format: {
              type: "json_schema",
              schema: yield* jsonSchema(options.responseFormat.schema),
            },
          }
        : {};
    const outputConfig = { ...format, ...(thinking ? { effort } : {}) };
    return {
      model: call.model,
      max_tokens: call.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
      ...(system.length > 0 ? { system } : {}),
      messages: alternate(messages),
      // Summarised, since newer models omit their thinking text unless asked.
      ...(thinking ? { thinking: { type: "adaptive", display: "summarized" } } : {}),
      ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
      ...(selection.tools.length > 0
        ? {
            tools: selection.tools.map((tool) => ({
              name: tool.name,
              ...(tool.description ? { description: tool.description } : {}),
              input_schema: tool.parameters,
              // Arguments as they are written, not each value held back until
              // complete: a document written through a tool lands as it streams.
              // Broken JSON still fails the call when it closes.
              eager_input_streaming: true,
            })),
            ...(choice ? { tool_choice: choice } : {}),
          }
        : {}),
    };
  });

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

const FINISH_REASONS: Record<string, FinishReason> = {
  end_turn: "stop",
  stop_sequence: "stop",
  tool_use: "tool-calls",
  max_tokens: "length",
  model_context_window_exceeded: "length",
  refusal: "content-filter",
};

/** One model call over Anthropic's Messages API, as Effect stream parts. */
export const streamMessages = (
  connection: Connection,
  call: ModelCall,
  options: LanguageModel.ProviderOptions,
): Stream.Stream<StreamPart, AiError.AiError, IdGenerator.IdGenerator | HttpClient.HttpClient> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const url = connection.preset.messages?.url(connection.baseUrl);
      if (!url) return yield* Effect.fail(configurationError("This provider has no Messages API."));
      yield* checkCall(connection, call, options);
      const body = yield* buildMessagesRequest(connection, call, options);
      options.span.attribute("gen_ai.system", connection.preset.id);
      options.span.attribute("gen_ai.request.model", call.model);
      // Anthropic's own key header, unless the request is signed instead.
      const keyed: Connection = {
        ...connection,
        settings: { ...connection.settings, keyHeader: "x-api-key" },
      };
      const response = yield* postJson(keyed, url, body, { "anthropic-version": "2023-06-01" });
      const decoder = makeMessagesDecoder(connection, call, yield* IdGenerator.IdGenerator);
      return sseEvents(responseBytes(response), () =>
        invalidOutput("The provider sent an event larger than allowed"),
      ).pipe(
        Stream.mapEffect((event) => decoder.event(event.data)),
        Stream.concat(Stream.fromEffect(decoder.end)),
        Stream.flattenIterable,
        Stream.takeUntil((part) => part.type === "finish"),
      );
    }),
  );

interface Block {
  type: string;
  /** Tool use only. */
  id: string;
  name: string;
  args: string;
  input: unknown;
  /** Thinking only. */
  thinking: string;
  signature: string;
  data: string;
  text: string;
}

export const makeMessagesDecoder = (
  connection: Connection,
  call: ModelCall,
  idGenerator: IdGenerator.Service,
) => {
  const identity = identityOf(connection, call.model);
  const blocks = makeBlocks(idGenerator);
  const content = new Map<number, Block>();
  let stopReason: string | undefined;
  let startUsage: Json = {};
  let deltaUsage: Json = {};
  let stopped = false;
  let ended = false;

  const event = (data: string) =>
    Effect.gen(function* () {
      if (ended) return [];
      let chunk: unknown;
      try {
        chunk = JSON.parse(data);
      } catch {
        return yield* Effect.fail(
          invalidOutput("The provider sent a stream event that is not JSON"),
        );
      }
      if (!isRecord(chunk) || typeof chunk["type"] !== "string")
        return yield* Effect.fail(invalidOutput("The provider sent an unexpected stream event"));
      const parts: StreamPart[] = [];
      const index = typeof chunk["index"] === "number" ? chunk["index"] : -1;
      switch (chunk["type"]) {
        case "message_start": {
          const message = isRecord(chunk["message"]) ? chunk["message"] : {};
          if (isRecord(message["usage"])) startUsage = message["usage"];
          parts.push({
            type: "response-metadata",
            ...(str(message["id"]) ? { id: str(message["id"]) } : {}),
            ...(str(message["model"]) ? { modelId: str(message["model"]) } : {}),
            timestamp: DateTime.formatIso(yield* DateTime.now),
          });
          break;
        }
        case "content_block_start": {
          const start = isRecord(chunk["content_block"]) ? chunk["content_block"] : {};
          const block: Block = {
            type: str(start["type"]) ?? "",
            id: str(start["id"]) ?? "",
            name: str(start["name"]) ?? "",
            args: "",
            input: start["input"],
            thinking: str(start["thinking"]) ?? "",
            signature: str(start["signature"]) ?? "",
            data: str(start["data"]) ?? "",
            text: str(start["text"]) ?? "",
          };
          content.set(index, block);
          if (block.type === "text" && block.text)
            parts.push(...(yield* blocks.write("text", block.text)));
          if (block.type === "thinking" && block.thinking)
            parts.push(...(yield* blocks.write("reasoning", block.thinking)));
          if (block.type === "tool_use" && block.id && block.name)
            parts.push({ type: "tool-params-start", id: block.id, name: block.name });
          break;
        }
        case "content_block_delta": {
          const block = content.get(index);
          const delta = isRecord(chunk["delta"]) ? chunk["delta"] : {};
          if (!block) break;
          switch (delta["type"]) {
            case "text_delta": {
              const text = str(delta["text"]) ?? "";
              block.text += text;
              parts.push(...(yield* blocks.write("text", text)));
              break;
            }
            case "thinking_delta": {
              const thinking = str(delta["thinking"]) ?? "";
              block.thinking += thinking;
              parts.push(...(yield* blocks.write("reasoning", thinking)));
              break;
            }
            case "signature_delta":
              block.signature += str(delta["signature"]) ?? "";
              break;
            case "input_json_delta": {
              const json = str(delta["partial_json"]) ?? "";
              block.args += json;
              if (json && block.id)
                parts.push({ type: "tool-params-delta", id: block.id, delta: json });
              break;
            }
          }
          break;
        }
        case "message_delta": {
          const delta = isRecord(chunk["delta"]) ? chunk["delta"] : {};
          stopReason ??= str(delta["stop_reason"]);
          if (isRecord(chunk["usage"])) deltaUsage = chunk["usage"];
          break;
        }
        case "message_stop":
          stopped = true;
          // Finish now: a connection held open must not hold the answer.
          return yield* end;
        case "error":
          parts.push({ type: "error", error: chunk["error"] ?? chunk });
          break;
      }
      return parts;
    });

  const end = Effect.gen(function* () {
    if (ended) return [];
    ended = true;
    if (!stopped && stopReason === undefined)
      return yield* Effect.fail(networkError("The stream ended before the response finished"));
    const parts: StreamPart[] = [];
    const ordered = Array.from(content.entries())
      .toSorted(([a], [b]) => a - b)
      .map(([, block]) => block);
    let reason: FinishReason =
      stopReason === undefined ? "stop" : (FINISH_REASONS[stopReason] ?? "other");
    // A cut-off or refused answer's calls may be truncated: never run them.
    const executable = reason !== "length" && reason !== "content-filter";
    const finished: Array<{ block: Block; params: unknown }> = [];
    if (executable)
      for (const block of ordered.filter((each) => each.type === "tool_use")) {
        if (!block.id || !block.name)
          return yield* Effect.fail(invalidOutput("The provider sent a tool call without a name"));
        const parsed = block.args
          ? parseArguments(block.args)
          : { ok: true as const, value: block.input ?? {} };
        if (!parsed.ok)
          return yield* Effect.fail(
            invalidOutput("The provider sent tool call arguments that are not valid JSON"),
          );
        finished.push({ block, params: parsed.value });
      }
    if (finished.length > 0 && reason === "stop") reason = "tool-calls";

    const kept: Schema.Json[] = ordered.flatMap((block): Schema.Json[] => {
      switch (block.type) {
        case "thinking":
          return [{ type: "thinking", thinking: block.thinking, signature: block.signature }];
        case "redacted_thinking":
          return [{ type: "redacted_thinking", data: block.data }];
        case "text":
          return [{ type: "text", text: block.text }];
        case "tool_use":
          return [{ type: "tool_use", id: block.id }];
        default:
          return [];
      }
    });
    // Only thinking is state the model needs back; text and calls place it.
    const hasState = ordered.some(
      (block) => block.type === "thinking" || block.type === "redacted_thinking",
    );
    const unit: MessagesUnit = {
      v: 1,
      id: yield* idGenerator.generateId(),
      identity,
      format: "messages",
      blocks: kept,
    };
    const metadata = replayMetadata(hasState ? unit : undefined);
    parts.push(...blocks.close(metadata));
    for (const { block, params } of finished) {
      parts.push({ type: "tool-params-end", id: block.id });
      parts.push({
        type: "tool-call",
        id: block.id,
        name: block.name,
        params,
        ...(metadata ? { metadata } : {}),
      });
    }
    // Input and cache counts arrive at the start, output at the end.
    const usage = normalizeUsage({ ...startUsage, ...definedOnly(deltaUsage) });
    parts.push({
      type: "finish",
      reason,
      usage: usage?.usage ?? unknownUsage(),
      metadata: { modelClient: hasState ? { replay: unit } : {} },
    });
    return parts;
  });

  return { event, end };
};

const definedOnly = (value: Json) =>
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined),
  );
