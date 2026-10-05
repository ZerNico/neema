import { Effect, Encoding } from "effect";
import {
  AiError,
  type IdGenerator,
  type LanguageModel,
  type Prompt,
  type Response,
  Tool,
} from "effect/unstable/ai";
import { MODULE } from "./errors.ts";
import { METADATA_KEY, type ReplayUnit } from "./replay.ts";

export type StreamPart = Response.StreamPartEncoded;
export type FinishReason = Response.FinishPartEncoded["reason"];

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** A prompt file as a data URL, or its own URL when it is one. */
export const fileUrl = (part: Prompt.FilePart): string =>
  part.data instanceof URL
    ? part.data.toString()
    : `data:${part.mediaType};base64,${typeof part.data === "string" ? part.data : Encoding.encodeBase64(part.data)}`;

/** A streamed image (data URL or bare base64) as an encoded file part. */
export const imagePart = (url: string): StreamPart => {
  const match = /^data:([^;,]+)(?:;[^,]*)?,(.*)$/s.exec(url);
  return {
    type: "file",
    mediaType: match?.[1] ?? "image/png",
    data: match?.[2] ?? url,
  };
};

export const toolResultText = (result: unknown) =>
  typeof result === "string" ? result : JSON.stringify(result ?? null);

/** Tool definitions as JSON schemas, written as the toolkit defines them. */
export const toolSchemas = (
  options: LanguageModel.ProviderOptions,
  transformer?: LanguageModel.CodecTransformer,
) =>
  Effect.try({
    try: () =>
      options.tools.map((tool) => ({
        name: tool.name,
        description: Tool.getDescription(tool),
        parameters: Tool.getJsonSchema(tool, transformer ? { transformer } : undefined),
      })),
    catch: (error) =>
      AiError.make({
        module: MODULE,
        method: "tools",
        reason: new AiError.UnsupportedSchemaError({ description: String(error) }),
      }),
  });

/**
 * Which tools go out and what is asked of the model. A `oneOf` choice
 * advertises only those tools; a call to any other the toolkit has still runs,
 * since Effect resolves calls against the whole toolkit.
 */
export const toolSelection = <T extends { readonly name: string }>(
  tools: ReadonlyArray<T>,
  choice: LanguageModel.ProviderOptions["toolChoice"],
): {
  tools: ReadonlyArray<T>;
  choice: "auto" | "none" | "required" | { readonly name: string } | undefined;
} => {
  if (tools.length === 0) return { tools: [], choice: undefined };
  if (choice === "auto" || choice === "none" || choice === "required") return { tools, choice };
  if ("tool" in choice) return { tools, choice: { name: choice.tool } };
  const allowed = new Set(choice.oneOf);
  const offered = tools.filter((tool) => allowed.has(tool.name));
  if (offered.length === 0) return { tools: [], choice: undefined };
  return { tools: offered, choice: choice.mode === "required" ? "required" : "auto" };
};

/** A structured-output schema as JSON schema. */
export const jsonSchema = (
  schema: Extract<LanguageModel.ProviderOptions["responseFormat"], { type: "json" }>["schema"],
) =>
  Effect.try({
    try: () => Tool.getJsonSchemaFromSchema(schema),
    catch: (error) =>
      AiError.make({
        module: MODULE,
        method: "responseFormat",
        reason: new AiError.UnsupportedSchemaError({ description: String(error) }),
      }),
  });

/** Whether the app marked a message as the end of a stable, cacheable prefix. */
export const isAnchor = (message: Prompt.Message) =>
  isRecord(message.options["cache"]) && message.options["cache"]["anchor"] === true;

/** Anthropic honours at most four cache breakpoints per request. */
export const MAX_CACHE_MARKERS = 4;

/**
 * The anchored messages that get a cache marker: all of them within the
 * budget, else the first (the system prompt, stable longest) and the latest.
 */
export const markerBudget = (prompt: Prompt.Prompt) => {
  const anchored = prompt.content.filter(
    (message) => message.role !== "assistant" && isAnchor(message),
  );
  if (anchored.length <= MAX_CACHE_MARKERS) return new Set(anchored);
  return new Set([anchored[0]!, ...anchored.slice(-(MAX_CACHE_MARKERS - 1))]);
};

/**
 * Files in an assistant turn (an answer's image, a tool's PDF) have no place
 * on most servers. They follow the turn, after its tool results, as a user
 * message, so the model still sees them. OpenRouter takes images inline.
 */
export const carryAssistantFiles = (prompt: Prompt.Prompt, keepImages: boolean) => {
  const messages: Array<Prompt.Message | { role: "carried"; files: Prompt.FilePart[] }> = [];
  let carried: Prompt.FilePart[] = [];
  const flush = () => {
    if (carried.length > 0) messages.push({ role: "carried", files: carried });
    carried = [];
  };
  for (const message of prompt.content) {
    if (message.role !== "tool") flush();
    messages.push(message);
    if (message.role === "assistant")
      carried = message.content.filter(
        (part): part is Prompt.FilePart =>
          part.type === "file" && !(keepImages && part.mediaType.startsWith("image/")),
      );
  }
  flush();
  return messages;
};

export const replayMetadata = (unit: ReplayUnit | undefined) =>
  unit ? { [METADATA_KEY]: { replay: unit } } : undefined;

/**
 * Text and reasoning blocks of one round. A block closes when the other kind
 * starts, so start/end parts always pair up; whatever is open at the end
 * closes carrying the round's replay unit, which is how that state reaches the
 * prompt that continues the round.
 */
export const makeBlocks = (idGenerator: IdGenerator.Service) => {
  let open: { kind: "text" | "reasoning"; id: string } | undefined;
  return {
    write: (kind: "text" | "reasoning", delta: string, metadata?: Response.ProviderMetadata) =>
      Effect.gen(function* () {
        const parts: StreamPart[] = [];
        if (delta === "") return parts;
        if (open?.kind !== kind) {
          if (open) parts.push({ type: `${open.kind}-end`, id: open.id });
          open = { kind, id: yield* idGenerator.generateId() };
          parts.push({ type: `${kind}-start`, id: open.id });
        }
        parts.push({
          type: `${kind}-delta`,
          id: open.id,
          delta,
          ...(metadata ? { metadata } : {}),
        });
        return parts;
      }),
    close: (metadata?: Response.ProviderMetadata): StreamPart[] => {
      if (!open) return [];
      const part: StreamPart = {
        type: `${open.kind}-end`,
        id: open.id,
        ...(metadata ? { metadata } : {}),
      };
      open = undefined;
      return [part];
    },
  };
};

/**
 * Splits a `<think>` block that opens the answer out of streamed text, for
 * models that inline their reasoning (DeepSeek R1 distills, QwQ, many local
 * models). Only an opening block counts, as in vLLM's and SGLang's reasoning
 * parsers: a tag later in the answer is the answer's text, such as an
 * explanation of this very format. Tags split across chunks are held back
 * until they are known to be tags or text.
 */
export const makeThinkSplitter = () => {
  const OPEN = "<think>";
  const CLOSE = "</think>";
  let state: "start" | "thinking" | "text" = "start";
  let pending = "";
  type Piece = { kind: "text" | "reasoning"; text: string };
  const thinking = (text: string): Piece[] => {
    const buffer = pending + text;
    const at = buffer.indexOf(CLOSE);
    if (at !== -1) {
      state = "text";
      pending = "";
      const out: Piece[] = [];
      if (at > 0) out.push({ kind: "reasoning", text: buffer.slice(0, at) });
      const rest = buffer.slice(at + CLOSE.length);
      if (rest) out.push({ kind: "text", text: rest });
      return out;
    }
    let keep = 0;
    for (let length = Math.min(CLOSE.length - 1, buffer.length); length > 0; length--)
      if (CLOSE.startsWith(buffer.slice(-length))) {
        keep = length;
        break;
      }
    pending = buffer.slice(buffer.length - keep);
    const emit = buffer.slice(0, buffer.length - keep);
    return emit ? [{ kind: "reasoning", text: emit }] : [];
  };
  return {
    push: (text: string): Piece[] => {
      if (state === "text") return [{ kind: "text", text }];
      if (state === "thinking") return thinking(text);
      pending += text;
      const lead = pending.trimStart();
      if (lead.startsWith(OPEN)) {
        state = "thinking";
        pending = "";
        return thinking(lead.slice(OPEN.length));
      }
      // Still possibly the opening tag: wait for more.
      if (OPEN.startsWith(lead)) return [];
      state = "text";
      const out = pending;
      pending = "";
      return [{ kind: "text", text: out }];
    },
    flush: (): Piece[] => {
      const rest = pending;
      pending = "";
      if (!rest) return [];
      return [{ kind: state === "thinking" ? "reasoning" : "text", text: rest }];
    },
  };
};

/** Parses a finished tool call's arguments: empty means no arguments, broken JSON is no call. */
export const parseArguments = (text: string): { ok: true; value: unknown } | { ok: false } => {
  if (text.trim() === "") return { ok: true, value: {} };
  try {
    return { ok: true, value: Tool.unsafeSecureJsonParse(text) };
  } catch {
    return { ok: false };
  }
};
