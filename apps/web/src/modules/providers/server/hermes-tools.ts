import { emptyOptionalsDropper } from "@chat/model-client";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import {
  type AiError,
  IdGenerator,
  LanguageModel,
  Prompt,
  Response,
  Tool,
  Toolkit,
} from "effect/ai";

/**
 * Prompt-based tool calling for models that cannot take a `tools` parameter.
 *
 * `capabilities.tools` means *native* tool calling. A model without it is
 * wrapped here, inside the provider boundary, so the toolkit loop in
 * `chat/server/generation/round.ts` never learns the difference: the request carries the tool
 * signatures as a Hermes-style `<tools>` system block and the history as
 * `<tool_call>` / `<tool_response>` text, and the response's `<tool_call>`
 * blocks come back out as ordinary `tool-call` parts with `finish.reason`
 * set to `"tool-calls"`.
 */

type Part = Response.AnyPart;
type Metadata = Response.TextDeltaPartMetadata;
type ProviderOptions = LanguageModel.ProviderOptions;

const CALL_OPEN = "<tool_call>";
const CALL_CLOSE = "</tool_call>";
const RESPONSE_OPEN = "<tool_response>";
const RESPONSE_CLOSE = "</tool_response>";
const FENCE = "```";

/** Plain generations, titles and compaction never pay for the polyfill. */
export const needsHermesTools = (options: Pick<ProviderOptions, "tools" | "toolChoice">) =>
  options.tools.length > 0 && options.toolChoice !== "none";

const toolChoiceInstruction = (toolChoice: ProviderOptions["toolChoice"]): string | null => {
  if (toolChoice === "required") return "You must call at least one function in this response.";
  if (typeof toolChoice === "object") {
    if ("tool" in toolChoice)
      return `You must call the function named "${toolChoice.tool}" in this response.`;
    if (toolChoice.mode === "required")
      return `You must call one of these functions in this response: ${toolChoice.oneOf.join(", ")}.`;
  }
  return null;
};

/** The canonical NousResearch Hermes function-calling instructions. */
export const renderHermesSystemBlock = (
  tools: ReadonlyArray<Tool.Any>,
  toolChoice: ProviderOptions["toolChoice"] = "auto",
): string => {
  const signatures = tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: Tool.getJsonSchema(tool),
  }));
  return [
    "You are a function calling AI model. You are provided with function signatures within <tools></tools> XML tags. You may call one or more functions to assist with the user query. Don't make assumptions about what values to plug into functions. Here are the available tools:",
    `<tools>\n${JSON.stringify(signatures)}\n</tools>`,
    "For each function call return a json object with function name and arguments within <tool_call></tool_call> XML tags as follows, one call per pair of tags and nothing else inside them:",
    `${CALL_OPEN}\n{"name": <function-name>, "arguments": <args-dict>}\n${CALL_CLOSE}`,
    `Each result is returned to you inside ${RESPONSE_OPEN}${RESPONSE_CLOSE} XML tags; continue answering the user from it. Do not write ${CALL_OPEN} tags unless you are calling a function.`,
    toolChoiceInstruction(toolChoice),
  ]
    .filter((section) => section !== null)
    .join("\n\n");
};

const callText = (part: Prompt.ToolCallPart) =>
  `${CALL_OPEN}\n${JSON.stringify({ name: part.name, arguments: part.params })}\n${CALL_CLOSE}`;

const responseText = (part: Prompt.ToolResultPart) =>
  `${RESPONSE_OPEN}\n${JSON.stringify({
    name: part.name,
    id: part.id,
    ...(part.isFailure ? { error: true } : {}),
    content: part.result,
  })}\n${RESPONSE_CLOSE}`;

/**
 * Rewrites the prompt so the wire never carries `tool_calls` or a `tool`
 * role: assistant tool calls become `<tool_call>` text on that message, and
 * each run of tool messages becomes one user message of `<tool_response>`
 * blocks. The Hermes block is appended to the leading system messages,
 * after the app's own prompt, so cached prefixes stay stable.
 */
export const rewriteHermesPrompt = (input: {
  readonly prompt: Prompt.Prompt;
  readonly tools: ReadonlyArray<Tool.Any>;
  readonly toolChoice?: ProviderOptions["toolChoice"];
}): Prompt.Prompt => {
  const messages: Array<Prompt.Message> = [];
  let responses: Array<string> = [];
  const flushResponses = () => {
    if (responses.length === 0) return;
    messages.push(
      Prompt.makeMessage("user", {
        content: [Prompt.makePart("text", { text: responses.join("\n") })],
      }),
    );
    responses = [];
  };

  for (const message of input.prompt.content) {
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-result") responses.push(responseText(part));
      }
      continue;
    }
    flushResponses();
    if (message.role !== "assistant") {
      messages.push(message);
      continue;
    }
    const content: Array<Prompt.AssistantMessagePart> = [];
    for (const part of message.content) {
      if (part.type === "tool-call") {
        // The adapter joins text parts with no separator.
        const text = content.length > 0 ? `\n${callText(part)}` : callText(part);
        content.push(Prompt.makePart("text", { text }));
      } else if (part.type !== "tool-result" && part.type !== "tool-approval-request") {
        content.push(part);
      }
    }
    messages.push(Prompt.makeMessage("assistant", { content, options: message.options }));
  }
  flushResponses();

  const block = renderHermesSystemBlock(input.tools, input.toolChoice ?? "auto");
  let leading = 0;
  while (leading < messages.length && messages[leading]!.role === "system") leading++;
  if (leading === 0) {
    messages.unshift(Prompt.makeMessage("system", { content: block }));
  } else {
    const last = messages[leading - 1] as Prompt.SystemMessage;
    messages[leading - 1] = Prompt.makeMessage("system", {
      content: `${last.content}\n\n${block}`,
      options: last.options,
    });
  }
  return Prompt.fromMessages(messages);
};

interface ParsedCall {
  readonly name: string;
  readonly params: unknown;
}

/** How many trailing characters of `text` could start `tag`: held back until known. */
const partialTagSuffix = (text: string, tag: string): number => {
  const max = Math.min(text.length, tag.length - 1);
  for (let len = max; len > 0; len--) {
    if (text.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
};

// Built through `Response.makePart`: it stamps the part brand and defaults
// `metadata`, without which `Prompt.fromResponseParts` dies on the fold.
const textDelta = (out: Array<Part>, text: string, id: string, metadata: Metadata = {}) => {
  if (text.length === 0) return;
  out.push(Response.makePart("text-delta", { id, delta: text, metadata }));
};

/**
 * Scans text deltas for `<tool_call>` blocks, tolerant of arbitrary chunk
 * boundaries. Markers inside fenced code are inert text, so a model quoting
 * the format does not trigger a call. A block that is not valid JSON, lacks a
 * string `name`, or names a tool that was not offered is re-emitted verbatim
 * as text: the polyfill never invents a call.
 */
/**
 * Tool names the toolkit can run beyond those advertised this request. A
 * deferred tool is callable before its schema is shown, so its call must parse
 * as a call, not leak into the answer as `<tool_call>` text.
 */
export const HermesCallableTools = Context.Reference<ReadonlySet<string>>(
  "providers/HermesCallableTools",
  { defaultValue: () => new Set() },
);

const createHermesParser = (input: {
  readonly tools: ReadonlyArray<Tool.Any>;
  readonly callable?: ReadonlySet<string>;
  readonly nextId: Effect.Effect<string>;
}) => {
  const known = new Set([...input.tools.map((tool) => tool.name), ...(input.callable ?? [])]);
  // As the model client does for native calls.
  const dropEmpty = emptyOptionalsDropper(input.tools);
  let pending = "";
  let inCall = false;
  let inFence = false;
  let pendingCalls: Array<Part> = [];
  let terminal = false;

  const decodeCall = (raw: string): ParsedCall | null => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const { name, arguments: args } = parsed as Record<string, unknown>;
    if (typeof name !== "string" || !known.has(name)) return null;
    // Some models serialize the arguments object as a JSON string.
    let params: unknown = args ?? {};
    if (typeof params === "string") {
      try {
        params = JSON.parse(params);
      } catch {
        return null;
      }
    }
    if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
    return { name, params: dropEmpty(name, params) };
  };

  const emitCall = (out: Array<Part>, call: ParsedCall, id: string) => {
    out.push(
      Response.makePart("tool-params-start", { id, name: call.name, providerExecuted: false }),
      Response.makePart("tool-params-delta", { id, delta: JSON.stringify(call.params) }),
      Response.makePart("tool-params-end", { id }),
      Response.makePart("tool-call", {
        id,
        name: call.name,
        params: call.params,
        providerExecuted: false,
      }),
    );
  };

  const push = (delta: string, textId: string, metadata: Metadata) =>
    Effect.gen(function* () {
      const out: Array<Part> = [];
      pending += delta;
      for (;;) {
        if (inCall) {
          const end = pending.indexOf(CALL_CLOSE);
          if (end === -1) break;
          const raw = pending.slice(0, end);
          pending = pending.slice(end + CALL_CLOSE.length);
          inCall = false;
          const call = decodeCall(raw);
          if (call) {
            if (!terminal) emitCall(pendingCalls, call, yield* input.nextId);
          } else textDelta(out, `${CALL_OPEN}${raw}${CALL_CLOSE}`, textId, metadata);
          continue;
        }
        const fence = pending.indexOf(FENCE);
        const open = inFence ? -1 : pending.indexOf(CALL_OPEN);
        if (fence !== -1 && (open === -1 || fence < open)) {
          textDelta(out, pending.slice(0, fence + FENCE.length), textId, metadata);
          pending = pending.slice(fence + FENCE.length);
          inFence = !inFence;
          continue;
        }
        if (open !== -1) {
          textDelta(out, pending.slice(0, open), textId, metadata);
          pending = pending.slice(open + CALL_OPEN.length);
          inCall = true;
          continue;
        }
        break;
      }
      if (!inCall) {
        // Hold back only a possible split marker; emit the rest.
        const hold = Math.max(
          partialTagSuffix(pending, FENCE),
          inFence ? 0 : partialTagSuffix(pending, CALL_OPEN),
        );
        textDelta(out, pending.slice(0, pending.length - hold), textId, metadata);
        pending = pending.slice(pending.length - hold);
      }
      return out;
    });

  // An unterminated block or a held-back partial marker is literal text.
  const flush = (textId: string): Array<Part> => {
    const out: Array<Part> = [];
    textDelta(out, inCall ? `${CALL_OPEN}${pending}` : pending, textId);
    pending = "";
    inCall = false;
    return out;
  };

  const complete = (successful: boolean): Array<Part> => {
    const out = successful && !terminal ? pendingCalls : [];
    pendingCalls = [];
    terminal = true;
    return out;
  };

  return { push, flush, complete };
};

/**
 * Parsed calls stay inert until a successful terminal finish. Failures and EOF
 * discard them, since a toolkit handler's action cannot be undone afterwards.
 */
export const hermesToolCalls = <E, R>(
  source: Stream.Stream<Part, E, R>,
  input: {
    readonly tools: ReadonlyArray<Tool.Any>;
    readonly callable?: ReadonlySet<string>;
    readonly nextId: Effect.Effect<string>;
  },
): Stream.Stream<Part, E, R> =>
  Stream.suspend(() => {
    const parser = createHermesParser(input);
    let textId = "hermes-text";

    const transformed = source.pipe(
      Stream.mapEffect((part): Effect.Effect<Array<Part>> => {
        switch (part.type) {
          case "text-delta":
            textId = part.id;
            return parser.push(part.delta, part.id, part.metadata);
          case "finish": {
            const calls = parser.complete(part.reason === "stop" || part.reason === "tool-calls");
            const finish =
              calls.length === 0
                ? part
                : Response.makePart("finish", {
                    reason: "tool-calls",
                    usage: part.usage,
                    response: part.response,
                    metadata: part.metadata,
                  });
            return Effect.succeed([...parser.flush(textId), ...calls, finish]);
          }
          case "error":
            parser.complete(false);
            return Effect.succeed([...parser.flush(textId), part]);
          case "text-start":
          case "text-end":
            return Effect.succeed([...parser.flush(textId), part]);
          default:
            // Reasoning and metadata may interleave with a held-back block.
            return Effect.succeed([part]);
        }
      }),
      Stream.flattenIterable,
    );
    const tail = Stream.suspend(() => {
      parser.complete(false);
      return Stream.fromIterable(parser.flush(textId));
    });
    return transformed.pipe(Stream.concat(tail));
  });

// `generateText` is the folded stream: one parser serves both hooks.
const foldStreamParts = (parts: ReadonlyArray<Part>): Array<Part> => {
  const out: Array<Part> = [];
  const text = new Map<string, { text: string; metadata: Metadata }>();
  const reasoning = new Map<string, { text: string; metadata: Metadata }>();
  for (const part of parts) {
    switch (part.type) {
      case "text-start":
        text.set(part.id, { text: "", metadata: part.metadata });
        break;
      case "text-delta":
        text.get(part.id)!.text += part.delta;
        break;
      case "text-end": {
        const active = text.get(part.id);
        if (active) out.push(Response.makePart("text", active));
        text.delete(part.id);
        break;
      }
      case "reasoning-start":
        reasoning.set(part.id, { text: "", metadata: part.metadata });
        break;
      case "reasoning-delta":
        reasoning.get(part.id)!.text += part.delta;
        break;
      case "reasoning-end": {
        const active = reasoning.get(part.id);
        if (active) out.push(Response.makePart("reasoning", active));
        reasoning.delete(part.id);
        break;
      }
      case "tool-params-start":
      case "tool-params-delta":
      case "tool-params-end":
        break;
      default:
        out.push(part);
    }
  }
  return out;
};

// The inner service hands out *decoded* parts (`response-metadata.timestamp`
// is a `DateTime`), while a provider hook must return the encoded shape
// `LanguageModel.make` decodes again. Tool calls are synthesized above already
// encoded (their params are the model's raw JSON), so only the rest goes back
// through the codec.
const encodeStreamPart = Schema.encodeEffect(Response.StreamPart(Toolkit.empty));
const encodePart = Schema.encodeEffect(Response.Part(Toolkit.empty));
const encodeStream = (
  part: Part,
): Effect.Effect<Response.StreamPartEncoded | Response.PartEncoded> =>
  part.type === "tool-call"
    ? Effect.succeed(part as Response.ToolCallPartEncoded)
    : part.type === "text" || part.type === "reasoning"
      ? Effect.orDie(encodePart(part))
      : Effect.orDie(encodeStreamPart(part as Response.StreamPart<{}>));

const hermesLayer = Layer.effect(
  LanguageModel.LanguageModel,
  Effect.gen(function* () {
    const inner = yield* LanguageModel.LanguageModel;
    // The inner service only exposes the toolkit-level API, so the request
    // goes through it with no toolkit: the adapter then sends neither `tools`
    // nor `tool_choice`, and the rewritten prompt carries the tools instead.
    const stream = (
      options: ProviderOptions,
    ): Stream.Stream<Part, AiError.AiError, IdGenerator.IdGenerator> =>
      needsHermesTools(options)
        ? Stream.unwrap(
            Effect.map(
              Effect.all([IdGenerator.IdGenerator, HermesCallableTools]),
              ([ids, callable]) =>
                hermesToolCalls(inner.streamText({ prompt: rewriteHermesPrompt(options) }), {
                  tools: options.tools,
                  callable,
                  nextId: ids.generateId(),
                }),
            ),
          )
        : inner.streamText({ prompt: options.prompt });
    return yield* LanguageModel.make({
      streamText: (options) =>
        stream(options).pipe(Stream.mapEffect(encodeStream)) as Stream.Stream<
          Response.StreamPartEncoded,
          AiError.AiError,
          IdGenerator.IdGenerator
        >,
      generateText: (options) =>
        Stream.runCollect(stream(options)).pipe(
          Effect.flatMap((parts) => Effect.forEach(foldStreamParts(parts), encodeStream)),
        ) as Effect.Effect<Array<Response.PartEncoded>, AiError.AiError, IdGenerator.IdGenerator>,
    });
  }),
);

/** Wraps a provider's `LanguageModel` layer with the Hermes polyfill. */
export const withHermesTools = <E, R>(
  model: Layer.Layer<LanguageModel.LanguageModel, E, R>,
): Layer.Layer<LanguageModel.LanguageModel, E, R> => hermesLayer.pipe(Layer.provide(model));
