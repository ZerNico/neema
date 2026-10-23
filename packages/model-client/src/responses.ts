import { DateTime, Effect, type Schema, Stream } from "effect";
import { AiError, IdGenerator, type LanguageModel, type Prompt, type Response } from "effect/ai";
import {
  fileUrl,
  isRecord,
  jsonSchema,
  makeBlocks,
  parseArguments,
  replayMetadata,
  str,
  toolResultText,
  toolSchemas,
  toolSelection,
  type FinishReason,
  type StreamPart,
} from "./common.ts";
import type { HttpClient } from "effect/http";
import {
  identityOf,
  postJson,
  decodeEvents,
  type Connection,
  type ModelCall,
} from "./connection.ts";
import { invalidOutput, networkError } from "./errors.ts";
import { checkCall } from "./policy.ts";
import { sameIdentity, unitsOfMessage, type ReplayUnit } from "./replay.ts";
import { normalizeUsage, unknownUsage } from "./usage.ts";

type Json = Record<string, unknown>;
type ResponsesUnit = Extract<ReplayUnit, { format: "responses" }>;

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

const userContent = (part: Prompt.UserMessagePart): Json | null => {
  if (part.type === "text") return { type: "input_text", text: part.text };
  if (part.mediaType.startsWith("image/")) return { type: "input_image", image_url: fileUrl(part) };
  if (part.mediaType === "application/pdf")
    return {
      type: "input_file",
      filename: part.fileName ?? "document.pdf",
      file_data: fileUrl(part),
    };
  return null;
};

const messageText = (item: Json) =>
  Array.isArray(item["content"])
    ? item["content"]
        .map((part) => (isRecord(part) ? (str(part["text"]) ?? str(part["refusal"]) ?? "") : ""))
        .join("")
    : "";

/** An output item as an input item: what the API takes back without stored state. */
const replayItem = (item: Json): Json | null => {
  switch (item["type"]) {
    case "reasoning":
      return {
        type: "reasoning",
        id: item["id"],
        summary: Array.isArray(item["summary"]) ? item["summary"] : [],
        ...(item["encrypted_content"] ? { encrypted_content: item["encrypted_content"] } : {}),
        ...(Array.isArray(item["content"]) ? { content: item["content"] } : {}),
      };
    case "message":
      return {
        type: "message",
        role: "assistant",
        content: Array.isArray(item["content"])
          ? item["content"].map((part) =>
              isRecord(part) && part["type"] === "refusal"
                ? { type: "refusal", refusal: part["refusal"] }
                : {
                    type: "output_text",
                    text: isRecord(part) ? (part["text"] ?? "") : "",
                    annotations: [],
                  },
            )
          : [],
        // Commentary versus final answer; GPT-5.4+ reads it back.
        ...(item["phase"] ? { phase: item["phase"] } : {}),
      };
    default:
      return null;
  }
};

const callItem = (call: Prompt.ToolCallPart) => ({
  type: "function_call",
  call_id: call.id,
  name: call.name,
  arguments: typeof call.params === "string" ? call.params : JSON.stringify(call.params ?? {}),
});

const assistantItems = (message: Prompt.AssistantMessage, units: ReadonlyArray<ResponsesUnit>) => {
  const items: Json[] = [];
  const calls = message.content.filter((part) => part.type === "tool-call");
  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  const stored = units.flatMap((unit) =>
    unit.items.flatMap((item) => (isRecord(item) ? [item] : [])),
  );
  const storedText = stored
    .filter((item) => item["type"] === "message")
    .map(messageText)
    .join("");
  // Signed state is never sent beside text that changed since: then only the
  // reasoning goes back as received and the rest is rebuilt from the prompt.
  const exact = stored.length > 0 && storedText === text;
  const covered = new Set<string>();
  for (const item of stored) {
    if (item["type"] === "reasoning") {
      const replayed = replayItem(item);
      if (replayed) items.push(replayed);
      continue;
    }
    if (!exact) continue;
    if (item["type"] === "function_call") {
      // In its original place, from the prompt; a call whose result does not
      // follow is left out, since an orphan call is a hard API error.
      const call = calls.find((part) => part.id === str(item["call_id"]));
      if (!call) continue;
      covered.add(call.id);
      items.push(callItem(call));
      continue;
    }
    const replayed = replayItem(item);
    if (replayed) items.push(replayed);
  }
  if (!exact && text) items.push({ role: "assistant", content: text });
  for (const call of calls) if (!covered.has(call.id)) items.push(callItem(call));
  return items;
};

export const buildResponsesRequest = (
  connection: Connection,
  call: ModelCall,
  options: LanguageModel.ProviderOptions,
  withSummary = true,
) =>
  Effect.gen(function* () {
    const identity = identityOf(connection, call.model);
    const input: Json[] = [];
    // A unit goes out once per request: a repeated reasoning item is an API error.
    const sent = new Set<string>();
    let carried: Prompt.FilePart[] = [];
    const flush = () => {
      if (carried.length === 0) return;
      input.push({
        role: "user",
        content: [
          { type: "input_text", text: "Files from the previous answer:" },
          ...carried.flatMap((file) => userContent(file) ?? []),
        ],
      });
      carried = [];
    };
    for (const message of options.prompt.content) {
      if (message.role !== "tool") flush();
      switch (message.role) {
        case "system":
          input.push({ role: "system", content: message.content });
          break;
        case "user":
          input.push({
            role: "user",
            content: message.content.flatMap((part) => userContent(part) ?? []),
          });
          break;
        case "assistant": {
          const units = unitsOfMessage(message).filter(
            (unit): unit is ResponsesUnit =>
              unit.format === "responses" &&
              sameIdentity(unit.identity, identity) &&
              !sent.has(unit.id),
          );
          for (const unit of units) sent.add(unit.id);
          input.push(...assistantItems(message, units));
          carried = message.content.filter((part): part is Prompt.FilePart => part.type === "file");
          break;
        }
        case "tool":
          for (const part of message.content)
            if (part.type === "tool-result")
              input.push({
                type: "function_call_output",
                call_id: part.id,
                output: toolResultText(part.result),
              });
          break;
      }
    }
    flush();

    const schemas = yield* toolSchemas(options);
    const selection = toolSelection(schemas, options.toolChoice);
    const reasoning = call.capabilities.reasoning;
    const effort = call.reasoningEffort ?? undefined;
    return {
      model: call.model,
      input,
      stream: true,
      // Nothing is kept at the provider; reasoning carries over as encrypted items.
      store: false,
      ...(call.maxOutputTokens === undefined ? {} : { max_output_tokens: call.maxOutputTokens }),
      ...(reasoning
        ? {
            include: ["reasoning.encrypted_content"],
            // Summaries are opt-in, and they are what streams as reasoning.
            reasoning: {
              ...(effort ? { effort } : {}),
              ...(withSummary ? { summary: "auto" } : {}),
            },
          }
        : {}),
      ...(call.cacheKey && connection.settings.cacheKey === "prompt_cache_key"
        ? { prompt_cache_key: call.cacheKey }
        : {}),
      ...(selection.tools.length > 0
        ? {
            tools: selection.tools.map((tool) => ({
              type: "function",
              name: tool.name,
              ...(tool.description ? { description: tool.description } : {}),
              parameters: tool.parameters,
              // Omitted means strict here, which makes optional keys required and nullable.
              strict: false,
            })),
            ...(selection.choice === undefined
              ? {}
              : {
                  tool_choice:
                    typeof selection.choice === "string"
                      ? selection.choice
                      : { type: "function", name: selection.choice.name },
                }),
          }
        : {}),
      ...(options.responseFormat.type === "json"
        ? {
            text: {
              format: {
                type: "json_schema",
                name: options.responseFormat.objectName,
                schema: yield* jsonSchema(options.responseFormat.schema),
                strict: false,
              },
            },
          }
        : {}),
    };
  });

/** OpenAI refuses reasoning summaries to organisations it has not verified. */
const isSummaryRefusal = (error: AiError.AiError) =>
  error.reason._tag === "InvalidRequestError" &&
  /summar/i.test(error.message) &&
  /verif/i.test(error.message);

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

/** One model call over the Responses API, as Effect stream parts. */
export const streamResponses = (
  connection: Connection,
  call: ModelCall,
  options: LanguageModel.ProviderOptions,
): Stream.Stream<StreamPart, AiError.AiError, IdGenerator.IdGenerator | HttpClient.HttpClient> =>
  Stream.unwrap(
    Effect.gen(function* () {
      yield* checkCall(connection, call, options);
      options.span.attribute("gen_ai.system", connection.preset.id);
      options.span.attribute("gen_ai.request.model", call.model);
      const send = (withSummary: boolean) =>
        buildResponsesRequest(connection, call, options, withSummary).pipe(
          Effect.flatMap((body) => postJson(connection, "/responses", body)),
        );
      const response = yield* send(true).pipe(
        Effect.catch((error) =>
          call.capabilities.reasoning && isSummaryRefusal(error) ? send(false) : Effect.fail(error),
        ),
      );
      const decoder = makeResponsesDecoder(connection, call, yield* IdGenerator.IdGenerator);
      return decodeEvents(response, decoder);
    }),
  );

interface PendingCall {
  readonly itemId: string;
  readonly callId: string;
  readonly name: string;
  args: string;
  done: boolean;
}

export const makeResponsesDecoder = (
  connection: Connection,
  call: ModelCall,
  idGenerator: IdGenerator.Service,
) => {
  const identity = identityOf(connection, call.model);
  const blocks = makeBlocks(idGenerator);
  const items = new Map<number, Schema.Json>();
  const calls: PendingCall[] = [];
  let summaryAt: { item: string; index: number } | undefined;
  let terminal: { reason: FinishReason; usage: unknown } | undefined;
  let metadataSent = false;
  let ended = false;

  const reasoningDelta = (itemId: string, summaryIndex: number | undefined, delta: string) =>
    Effect.gen(function* () {
      // Summary parts of one item read as paragraphs.
      const at = { item: itemId, index: summaryIndex ?? 0 };
      const gap =
        summaryAt && summaryAt.item === at.item && summaryAt.index !== at.index ? "\n\n" : "";
      summaryAt = at;
      return yield* blocks.write("reasoning", gap + delta);
    });

  const event = (data: string) =>
    Effect.gen(function* () {
      if (ended || terminal) return [];
      // Only a response event says how a response ended; [DONE] alone says nothing.
      if (data.trim() === "[DONE]") return yield* end;
      let value: unknown;
      try {
        value = JSON.parse(data);
      } catch {
        return yield* Effect.fail(
          invalidOutput("The provider sent a stream event that is not JSON"),
        );
      }
      if (!isRecord(value) || typeof value["type"] !== "string")
        return yield* Effect.fail(invalidOutput("The provider sent an unexpected stream event"));
      const parts: StreamPart[] = [];
      const type = value["type"];
      const response = isRecord(value["response"]) ? value["response"] : undefined;
      switch (type) {
        case "response.created":
        case "response.in_progress":
          if (!metadataSent && response) {
            metadataSent = true;
            parts.push({
              type: "response-metadata",
              ...(str(response["id"]) ? { id: str(response["id"]) } : {}),
              ...(str(response["model"]) ? { modelId: str(response["model"]) } : {}),
              timestamp: DateTime.formatIso(yield* DateTime.now),
            });
          }
          break;
        case "response.output_item.added": {
          const item = isRecord(value["item"]) ? value["item"] : undefined;
          if (item?.["type"] === "function_call" && str(item["call_id"]) && str(item["name"])) {
            const pending: PendingCall = {
              itemId: str(item["id"]) ?? str(item["call_id"])!,
              callId: str(item["call_id"])!,
              name: str(item["name"])!,
              args: str(item["arguments"]) ?? "",
              done: false,
            };
            calls.push(pending);
            parts.push({ type: "tool-params-start", id: pending.callId, name: pending.name });
            if (pending.args)
              parts.push({ type: "tool-params-delta", id: pending.callId, delta: pending.args });
          }
          break;
        }
        case "response.output_text.delta": {
          const delta = str(value["delta"]);
          if (delta) parts.push(...(yield* blocks.write("text", delta)));
          break;
        }
        case "response.refusal.delta": {
          const delta = str(value["delta"]);
          if (delta)
            parts.push(...(yield* blocks.write("text", delta, { modelClient: { refusal: true } })));
          break;
        }
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta": {
          const delta = str(value["delta"]);
          const index =
            typeof value["summary_index"] === "number" ? value["summary_index"] : undefined;
          if (delta)
            parts.push(...(yield* reasoningDelta(str(value["item_id"]) ?? "", index, delta)));
          break;
        }
        case "response.function_call_arguments.delta": {
          const pending = calls.find((item) => item.itemId === str(value["item_id"]));
          const delta = str(value["delta"]);
          if (pending && delta) {
            pending.args += delta;
            parts.push({ type: "tool-params-delta", id: pending.callId, delta });
          }
          break;
        }
        case "response.output_item.done": {
          const item = isRecord(value["item"]) ? value["item"] : undefined;
          if (!item) break;
          const index =
            typeof value["output_index"] === "number" ? value["output_index"] : items.size;
          // A call keeps only its place and id: its arguments are the app's to
          // send, redacted or not, never a second copy kept here.
          items.set(
            index,
            (item["type"] === "function_call"
              ? { type: "function_call", call_id: str(item["call_id"]) ?? "" }
              : item) as Schema.Json,
          );
          if (item["type"] === "function_call") {
            const pending = calls.find((entry) => entry.callId === str(item["call_id"]));
            // The finished item's arguments are authoritative over the deltas.
            if (pending) {
              pending.args = str(item["arguments"]) ?? pending.args;
              pending.done = true;
            }
          }
          break;
        }
        case "response.completed":
        case "response.incomplete":
        case "response.failed": {
          const reason = isRecord(response?.["incomplete_details"])
            ? str(response["incomplete_details"]["reason"])
            : undefined;
          if (type === "response.failed") {
            const error = response?.["error"];
            parts.push({
              type: "error",
              error: isRecord(error)
                ? error
                : { message: "The provider could not complete this response" },
            });
          }
          terminal = {
            reason:
              type === "response.failed"
                ? "error"
                : type === "response.incomplete"
                  ? reason === "content_filter"
                    ? "content-filter"
                    : "length"
                  : calls.length > 0
                    ? "tool-calls"
                    : "stop",
            usage: response?.["usage"],
          };
          // Finish now: a connection held open after the terminal event must not hold the answer.
          parts.push(...(yield* end));
          break;
        }
        case "error":
          parts.push({
            type: "error",
            error: isRecord(value["error"]) ? value["error"] : value,
          });
          break;
        default:
          break;
      }
      return parts;
    });

  const end = Effect.gen(function* () {
    if (ended) return [];
    ended = true;
    if (!terminal)
      return yield* Effect.fail(networkError("The stream ended before the response finished"));
    const parts: StreamPart[] = [];
    const executable = terminal.reason === "tool-calls";
    const finished: Array<{ call: PendingCall; params: unknown }> = [];
    if (executable)
      for (const pending of calls) {
        const parsed = parseArguments(pending.args);
        if (!parsed.ok)
          return yield* Effect.fail(
            invalidOutput("The provider sent tool call arguments that are not valid JSON"),
          );
        finished.push({ call: pending, params: parsed.value });
      }
    const ordered = [...items.entries()].toSorted(([a], [b]) => a - b).map(([, item]) => item);
    const unit: ReplayUnit = {
      v: 1,
      id: yield* idGenerator.generateId(),
      identity,
      format: "responses",
      items: ordered,
    };
    const metadata = replayMetadata(ordered.length > 0 ? unit : undefined);
    parts.push(...blocks.close(metadata));
    for (const { call: pending, params } of finished) {
      parts.push({ type: "tool-params-end", id: pending.callId });
      parts.push({
        type: "tool-call",
        id: pending.callId,
        name: pending.name,
        params,
        ...(metadata ? { metadata } : {}),
      });
    }
    const usage = normalizeUsage(terminal.usage);
    parts.push({
      type: "finish",
      reason: terminal.reason,
      usage: usage?.usage ?? unknownUsage(),
      metadata: {
        modelClient: {
          ...(usage?.cost === undefined ? {} : { cost: usage.cost }),
          ...(ordered.length > 0 ? { replay: unit } : {}),
        },
      } satisfies Response.ProviderMetadata,
    });
    return parts;
  });

  return { event, end };
};
