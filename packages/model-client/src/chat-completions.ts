import { DateTime, Effect, type Schema, Stream } from "effect";
import {
  type AiError,
  IdGenerator,
  type LanguageModel,
  type Prompt,
  type Response,
} from "effect/unstable/ai";
import {
  carryAssistantFiles,
  fileUrl,
  jsonSchema,
  imagePart,
  isRecord,
  makeBlocks,
  makeThinkSplitter,
  markerBudget,
  parseArguments,
  replayMetadata,
  str,
  toolResultText,
  toolSchemas,
  toolSelection,
  type FinishReason,
  type StreamPart,
  claudeHeaders,
} from "./common.ts";
import type { HttpClient } from "effect/unstable/http";
import {
  identityOf,
  postJson,
  responseBytes,
  type Connection,
  type ModelCall,
} from "./connection.ts";
import { invalidOutput, networkError } from "./errors.ts";
import { checkCall } from "./policy.ts";
import { sameIdentity, unitsOfMessage, type ReplayUnit } from "./replay.ts";
import { sseEvents } from "./sse.ts";
import { normalizeUsage, unknownUsage } from "./usage.ts";

type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

const userPart = (part: Prompt.UserMessagePart): Json | null => {
  if (part.type === "text") return { type: "text", text: part.text };
  if (part.mediaType.startsWith("image/"))
    return { type: "image_url", image_url: { url: fileUrl(part) } };
  if (part.mediaType === "application/pdf")
    return {
      type: "file",
      file: { filename: part.fileName ?? "document.pdf", file_data: fileUrl(part) },
    };
  return null;
};

/** Message content: a plain string where possible, since some servers take nothing else. */
const content = (parts: ReadonlyArray<Json>, marked: boolean): string | ReadonlyArray<Json> => {
  if (!marked && parts.length === 1 && parts[0]!["type"] === "text")
    return String(parts[0]!["text"]);
  if (!marked) return parts;
  return parts.map((part, index) =>
    index === parts.length - 1 ? { ...part, cache_control: { type: "ephemeral" } } : part,
  );
};

const reasoningFields = (connection: Connection, effort: string | null | undefined): Json => {
  if (effort === null || effort === undefined) return {};
  switch (connection.settings.reasoning) {
    case "flat":
      return { reasoning_effort: effort };
    case "nested":
      return { reasoning: { effort } };
    default:
      return {};
  }
};

export const buildChatRequest = (
  connection: Connection,
  call: ModelCall,
  options: LanguageModel.ProviderOptions,
) =>
  Effect.gen(function* () {
    const identity = identityOf(connection, call.model);
    const sendReasoning = connection.settings.sendReasoning;
    const markers =
      connection.preset.cacheMarkers?.test(call.model) === true
        ? markerBudget(options.prompt)
        : new Set<Prompt.Message>();

    const messages: Json[] = [];
    // A unit goes out once per request, however many messages carry it.
    const sent = new Set<string>();
    for (const message of carryAssistantFiles(options.prompt, connection.preset.imageOutput)) {
      switch (message.role) {
        case "carried":
          messages.push({
            role: "user",
            content: [
              { type: "text", text: "Files from the previous answer:" },
              ...message.files.map(userPart).filter((part) => part !== null),
            ],
          });
          break;
        case "system":
          messages.push({
            role: "system",
            content: content([{ type: "text", text: message.content }], markers.has(message)),
          });
          break;
        case "user":
          messages.push({
            role: "user",
            content: content(
              message.content.map(userPart).filter((part) => part !== null),
              markers.has(message),
            ),
          });
          break;
        case "assistant": {
          let text = "";
          const images: Json[] = [];
          const toolCalls: Json[] = [];
          const units = unitsOfMessage(message).filter(
            (unit): unit is Extract<ReplayUnit, { format: "chat-completions" }> =>
              unit.format === "chat-completions" &&
              sameIdentity(unit.identity, identity) &&
              !sent.has(unit.id),
          );
          for (const unit of units) sent.add(unit.id);
          const extras = Object.assign({}, ...units.map((unit) => unit.callExtras ?? {})) as Json;
          for (const part of message.content) {
            if (part.type === "text") text += part.text;
            else if (part.type === "file" && part.mediaType.startsWith("image/"))
              images.push({ type: "image_url", image_url: { url: fileUrl(part) } });
            else if (part.type === "tool-call")
              toolCalls.push({
                id: part.id,
                type: "function",
                function: {
                  name: part.name,
                  arguments:
                    typeof part.params === "string"
                      ? part.params
                      : JSON.stringify(part.params ?? {}),
                },
                // Gemini's thought signatures, through any route that passed them on.
                ...(extras[part.id] !== undefined ? { extra_content: extras[part.id] } : {}),
              });
          }
          const details = units.flatMap((unit) => unit.reasoningDetails ?? []);
          const reasoningContent = units.map((unit) => unit.reasoningContent ?? "").join("");
          messages.push({
            role: "assistant",
            content: text,
            ...(images.length > 0 && connection.preset.imageOutput ? { images } : {}),
            // The setting at request time decides, so switching it off takes effect at once.
            ...(sendReasoning && details.length > 0 ? { reasoning_details: details } : {}),
            ...(sendReasoning && reasoningContent ? { reasoning_content: reasoningContent } : {}),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          });
          break;
        }
        case "tool": {
          const results = message.content.filter((part) => part.type === "tool-result");
          results.forEach((part, index) => {
            const text = toolResultText(part.result);
            messages.push({
              role: "tool",
              tool_call_id: part.id,
              // A marked round caches through its last result, which needs a text part.
              content:
                markers.has(message) && index === results.length - 1
                  ? [{ type: "text", text, cache_control: { type: "ephemeral" } }]
                  : text,
            });
          });
          break;
        }
      }
    }

    const schemas = yield* toolSchemas(options);
    const selection = toolSelection(schemas, options.toolChoice);
    const responseFormat =
      options.responseFormat.type === "json"
        ? {
            response_format: {
              type: "json_schema",
              json_schema: {
                name: options.responseFormat.objectName,
                schema: yield* jsonSchema(options.responseFormat.schema),
                strict: false,
              },
            },
          }
        : {};

    const settings = connection.settings;
    const imageOutput =
      connection.preset.imageOutput &&
      call.imageOutput === true &&
      call.capabilities.imageOutput === true;
    return {
      model: call.model,
      messages,
      stream: true,
      ...(settings.streamUsage ? { stream_options: { include_usage: true } } : {}),
      ...(call.maxOutputTokens === undefined
        ? {}
        : { [settings.maxTokensField]: call.maxOutputTokens }),
      ...reasoningFields(connection, call.reasoningEffort),
      ...(connection.preset.imageOutput
        ? { modalities: imageOutput ? ["text", "image"] : ["text"] }
        : {}),
      ...(call.cacheKey && settings.cacheKey === "session_id"
        ? { session_id: call.cacheKey, prompt_cache_key: call.cacheKey }
        : call.cacheKey && settings.cacheKey === "prompt_cache_key"
          ? { prompt_cache_key: call.cacheKey }
          : {}),
      ...(selection.tools.length > 0
        ? {
            tools: selection.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                ...(tool.description ? { description: tool.description } : {}),
                parameters: tool.parameters,
              },
            })),
            ...(selection.choice === undefined
              ? {}
              : {
                  tool_choice:
                    typeof selection.choice === "string"
                      ? selection.choice
                      : { type: "function", function: { name: selection.choice.name } },
                }),
          }
        : {}),
      ...responseFormat,
    };
  });

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

const FINISH_REASONS: Record<string, FinishReason> = {
  stop: "stop",
  end_turn: "stop",
  length: "length",
  max_tokens: "length",
  tool_calls: "tool-calls",
  function_call: "tool-calls",
  content_filter: "content-filter",
  error: "error",
};

interface PendingCall {
  readonly index: number | undefined;
  id: string;
  name: string;
  args: string;
  extras: Schema.Json | undefined;
  started: boolean;
  /** Its id was made up here because none had arrived when the call began. */
  synthetic: boolean;
}

/** Merges OpenRouter reasoning detail deltas: consecutive text or summary pieces of one index join. */
const mergeDetail = (details: Schema.Json[], detail: unknown) => {
  if (!isRecord(detail)) return;
  const last = details.at(-1);
  const type = detail["type"];
  if (
    isRecord(last) &&
    last["type"] === type &&
    (type === "reasoning.text" || type === "reasoning.summary") &&
    last["index"] === detail["index"] &&
    // A detail with its own id starts a new block.
    (detail["id"] === undefined || detail["id"] === null || detail["id"] === last["id"])
  ) {
    const field = type === "reasoning.text" ? "text" : "summary";
    const merged: Record<string, Schema.Json> = { ...last };
    if (str(last[field]) !== undefined || str(detail[field]) !== undefined)
      merged[field] = (str(last[field]) ?? "") + (str(detail[field]) ?? "");
    for (const key of Object.keys(detail))
      if (key !== field && detail[key] !== null && detail[key] !== undefined)
        merged[key] = detail[key] as Schema.Json;
    details[details.length - 1] = merged;
    return;
  }
  details.push({ ...detail } as Schema.Json);
};

/** One model call over Chat Completions, as Effect stream parts. */
export const streamChat = (
  connection: Connection,
  call: ModelCall,
  options: LanguageModel.ProviderOptions,
): Stream.Stream<StreamPart, AiError.AiError, IdGenerator.IdGenerator | HttpClient.HttpClient> =>
  Stream.unwrap(
    Effect.gen(function* () {
      yield* checkCall(connection, call, options);
      const body = yield* buildChatRequest(connection, call, options);
      options.span.attribute("gen_ai.system", connection.preset.id);
      options.span.attribute("gen_ai.request.model", call.model);
      const response = yield* postJson(connection, "/chat/completions", body, claudeHeaders(call));
      const idGenerator = yield* IdGenerator.IdGenerator;
      const decoder = makeChatDecoder(connection, call, idGenerator);
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

/** Message content as text, reasoning or image pieces, string or typed chunks alike. */
const contentPieces = (
  value: unknown,
): Array<{ kind: "text" | "reasoning" | "image"; text: string }> => {
  if (typeof value === "string") return [{ kind: "text", text: value }];
  if (!Array.isArray(value)) return [];
  // Mistral and some servers stream content as typed chunks.
  return value.flatMap((chunk): Array<{ kind: "text" | "reasoning" | "image"; text: string }> => {
    if (!isRecord(chunk)) return [];
    if (chunk["type"] === "text" && typeof chunk["text"] === "string")
      return [{ kind: "text", text: chunk["text"] }];
    if (chunk["type"] === "thinking") {
      const thinking = chunk["thinking"];
      const text = Array.isArray(thinking)
        ? thinking.map((item) => (isRecord(item) ? (str(item["text"]) ?? "") : "")).join("")
        : (str(thinking) ?? "");
      return [{ kind: "reasoning", text }];
    }
    if (
      chunk["type"] === "image_url" &&
      isRecord(chunk["image_url"]) &&
      str(chunk["image_url"]["url"])
    )
      return [{ kind: "image", text: str(chunk["image_url"]["url"])! }];
    return [];
  });
};

export const makeChatDecoder = (
  connection: Connection,
  call: ModelCall,
  idGenerator: IdGenerator.Service,
) => {
  const identity = identityOf(connection, call.model);
  const blocks = makeBlocks(idGenerator);
  const imageOutput = connection.preset.imageOutput && call.imageOutput === true;
  // Off for image output: images and held-back text could change places.
  const think = imageOutput ? undefined : makeThinkSplitter();
  const calls: PendingCall[] = [];
  const details: Schema.Json[] = [];
  // Only what came in `reasoning_content` goes back "as received".
  let reasoningContentField = "";
  let finishRaw: string | undefined;
  let usage: ReturnType<typeof normalizeUsage> = null;
  let done = false;
  let ended = false;
  let metadataSent = false;
  let syntheticIds = 0;

  const writeText = (
    kind: "text" | "reasoning",
    text: string,
    metadata?: Response.ProviderMetadata,
  ) => {
    return blocks.write(kind, text, metadata);
  };

  const writeContent = (text: string) =>
    Effect.gen(function* () {
      const parts: StreamPart[] = [];
      for (const piece of think ? think.push(text) : [{ kind: "text" as const, text }])
        parts.push(...(yield* writeText(piece.kind, piece.text)));
      return parts;
    });

  const callFor = (delta: Record<string, unknown>, position: number, batch: number) => {
    const index = typeof delta["index"] === "number" ? delta["index"] : undefined;
    const id = str(delta["id"]) || undefined;
    const byId = id ? calls.find((pending) => pending.id === id) : undefined;
    if (byId) return byId;
    if (index !== undefined) {
      const byIndex = calls.findLast((pending) => pending.index === index);
      // Ollama numbers every parallel call 0; a different id there is a new call.
      // An id arriving after we had to make one up is the same call's.
      if (byIndex && !(id && byIndex.started && !byIndex.synthetic && byIndex.id !== id))
        return byIndex;
    } else if (!id && batch === 1 && calls.length > 0 && position === 0) {
      return calls.at(-1)!;
    }
    const created: PendingCall = {
      index,
      id: id ?? "",
      name: "",
      args: "",
      extras: undefined,
      started: false,
      synthetic: false,
    };
    calls.push(created);
    return created;
  };

  const toolDeltas = (list: ReadonlyArray<unknown>) => {
    const parts: StreamPart[] = [];
    list.forEach((raw, position) => {
      if (!isRecord(raw)) return;
      const pending = callFor(raw, position, list.length);
      const fn = isRecord(raw["function"]) ? raw["function"] : {};
      if (!pending.id && str(raw["id"])) pending.id = str(raw["id"])!;
      if (!pending.name && str(fn["name"])) pending.name = str(fn["name"])!;
      if (raw["extra_content"] !== undefined) pending.extras = raw["extra_content"] as Schema.Json;
      const args = fn["arguments"];
      let delta = "";
      if (typeof args === "string") {
        // Some relays repeat the whole argument string in the closing chunk.
        const complete = pending.args !== "" && parseArguments(pending.args).ok;
        if (!(complete && args === pending.args)) delta = args;
      } else if (isRecord(args)) {
        // A whole object instead of a JSON string (some local servers).
        delta = pending.args === "" ? JSON.stringify(args) : "";
      }
      pending.args += delta;
      if (!pending.started && pending.name) {
        if (!pending.id) {
          pending.id = `call_${++syntheticIds}`;
          pending.synthetic = true;
        }
        pending.started = true;
        parts.push({ type: "tool-params-start", id: pending.id, name: pending.name });
        if (pending.args)
          parts.push({ type: "tool-params-delta", id: pending.id, delta: pending.args });
      } else if (pending.started && delta) {
        parts.push({ type: "tool-params-delta", id: pending.id, delta });
      }
    });
    return parts;
  };

  const event = (data: string) =>
    Effect.gen(function* () {
      if (ended) return [];
      if (data.trim() === "[DONE]") {
        done = true;
        // Finish now: a relay holding the connection open must not hold the answer.
        return yield* end;
      }
      let chunk: unknown;
      try {
        chunk = JSON.parse(data);
      } catch {
        return yield* Effect.fail(
          invalidOutput("The provider sent a stream event that is not JSON"),
        );
      }
      if (!isRecord(chunk))
        return yield* Effect.fail(invalidOutput("The provider sent an unexpected stream event"));
      const parts: StreamPart[] = [];
      if (chunk["error"] !== undefined && chunk["error"] !== null) {
        // A rejection after the stream opened: the provider's own error object.
        parts.push({ type: "error", error: chunk["error"] });
        return parts;
      }
      const choices = chunk["choices"];
      if (!Array.isArray(choices) && chunk["usage"] === undefined && chunk["id"] === undefined)
        return yield* Effect.fail(invalidOutput("The provider sent an unexpected stream event"));

      if (!metadataSent && (str(chunk["id"]) || str(chunk["model"]))) {
        metadataSent = true;
        parts.push({
          type: "response-metadata",
          ...(str(chunk["id"]) ? { id: str(chunk["id"]) } : {}),
          ...(str(chunk["model"]) ? { modelId: str(chunk["model"]) } : {}),
          timestamp: DateTime.formatIso(yield* DateTime.now),
        });
      }
      const reported = normalizeUsage(chunk["usage"]);
      if (reported) usage = reported;

      const choice = Array.isArray(choices) ? choices[0] : undefined;
      if (!isRecord(choice)) return parts;
      // The first reason stands: a usage chunk repeating "stop" must not hide a cut-off.
      if (finishRaw === undefined && str(choice["finish_reason"]))
        finishRaw = str(choice["finish_reason"]);
      const delta = isRecord(choice["delta"])
        ? choice["delta"]
        : isRecord(choice["message"])
          ? choice["message"]
          : undefined;
      if (!delta) return parts;

      const detailList = delta["reasoning_details"];
      if (Array.isArray(detailList) && detailList.length > 0) {
        for (const detail of detailList) {
          mergeDetail(details, detail);
          if (!isRecord(detail)) continue;
          const visible =
            detail["type"] === "reasoning.text"
              ? str(detail["text"])
              : detail["type"] === "reasoning.summary"
                ? str(detail["summary"])
                : undefined;
          if (visible) parts.push(...(yield* writeText("reasoning", visible)));
        }
      } else {
        // One field per chunk: relays that fill both send the same text twice.
        const reasoningContent = str(delta["reasoning_content"]);
        const reasoning = reasoningContent ?? str(delta["reasoning"]);
        if (reasoningContent) reasoningContentField += reasoningContent;
        if (reasoning) parts.push(...(yield* writeText("reasoning", reasoning)));
      }

      for (const piece of contentPieces(delta["content"])) {
        if (piece.kind === "image") parts.push(imagePart(piece.text));
        else if (piece.kind === "reasoning")
          parts.push(...(yield* writeText("reasoning", piece.text)));
        else parts.push(...(yield* writeContent(piece.text)));
      }
      const refusal = str(delta["refusal"]);
      if (refusal)
        parts.push(...(yield* writeText("text", refusal, { modelClient: { refusal: true } })));

      if (Array.isArray(delta["images"]))
        for (const image of delta["images"]) {
          // OpenRouter documents `type` on image deltas as optional.
          const url =
            isRecord(image) && isRecord(image["image_url"])
              ? str(image["image_url"]["url"])
              : undefined;
          if (url) parts.push(imagePart(url));
        }

      if (Array.isArray(delta["tool_calls"])) parts.push(...toolDeltas(delta["tool_calls"]));
      return parts;
    });

  const end = Effect.gen(function* () {
    if (ended) return [];
    ended = true;
    // A finish reason closes the content, so a server ending the stream there
    // without [DONE] is accepted, its usage unknown; with neither it was cut off.
    if (!done && finishRaw === undefined)
      return yield* Effect.fail(networkError("The stream ended before the response finished"));
    const parts: StreamPart[] = [];
    if (think)
      for (const piece of think.flush()) parts.push(...(yield* writeText(piece.kind, piece.text)));

    let reason: FinishReason =
      finishRaw === undefined ? "stop" : (FINISH_REASONS[finishRaw] ?? "other");
    // A cut-off or filtered answer's calls may be truncated: never run them.
    const executable = reason !== "length" && reason !== "content-filter" && reason !== "error";
    const finished: Array<{ call: PendingCall; params: unknown }> = [];
    if (executable)
      for (const pending of calls) {
        if (!pending.name)
          return yield* Effect.fail(invalidOutput("The provider sent a tool call without a name"));
        const parsed = parseArguments(pending.args);
        if (!parsed.ok)
          return yield* Effect.fail(
            invalidOutput("The provider sent tool call arguments that are not valid JSON"),
          );
        finished.push({ call: pending, params: parsed.value });
      }
    // Gemini through some routes says `stop` after calling tools.
    if (finished.length > 0 && (reason === "stop" || reason === "other")) reason = "tool-calls";

    const callExtras: Record<string, Schema.Json> = {};
    for (const pending of calls)
      if (pending.extras !== undefined) callExtras[pending.id] = pending.extras;
    // The unit holds only what this provider sends back.
    const send = connection.settings.sendReasoning;
    const keptDetails = send && details.length > 0;
    // One field back, the one the server used; details carry the text already.
    const reasoningContent = send && !keptDetails ? reasoningContentField : "";
    const unit: ReplayUnit = {
      v: 1,
      id: yield* idGenerator.generateId(),
      identity,
      format: "chat-completions",
      ...(keptDetails ? { reasoningDetails: details } : {}),
      ...(reasoningContent ? { reasoningContent } : {}),
      ...(Object.keys(callExtras).length > 0 ? { callExtras } : {}),
    };
    const hasState =
      keptDetails || unit.reasoningContent !== undefined || unit.callExtras !== undefined;
    const metadata = replayMetadata(hasState ? unit : undefined);

    parts.push(...blocks.close(metadata));
    for (const { call: pending, params } of finished) {
      if (!pending.started) {
        pending.id ||= `call_${++syntheticIds}`;
        parts.push({ type: "tool-params-start", id: pending.id, name: pending.name });
      }
      parts.push({ type: "tool-params-end", id: pending.id });
      parts.push({
        type: "tool-call",
        id: pending.id,
        name: pending.name,
        params,
        ...(metadata ? { metadata } : {}),
      });
    }
    const cost = usage?.cost;
    parts.push({
      type: "finish",
      reason,
      usage: usage?.usage ?? unknownUsage(),
      metadata: {
        modelClient: {
          ...(cost === undefined ? {} : { cost }),
          ...(hasState ? { replay: unit } : {}),
        },
      },
    });
    return parts;
  });

  return { event, end };
};
