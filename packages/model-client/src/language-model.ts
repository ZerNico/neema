import { Effect, Layer, Stream } from "effect";
import { AiError, LanguageModel, type Response } from "effect/unstable/ai";
import { HttpClient } from "effect/unstable/http";
import { streamChat } from "./chat-completions.ts";
import type { StreamPart } from "./common.ts";
import type { Connection, ModelCall } from "./connection.ts";
import { MODULE } from "./errors.ts";
import { streamMessages } from "./messages.ts";
import { formatFor } from "./preset.ts";
import { streamResponses } from "./responses.ts";

const isModelNotSupported = (error: AiError.AiError) =>
  error.reason._tag === "InvalidRequestError" && /model not supported/i.test(error.message);

/**
 * Azure serves most deployments on Responses but not all, and names no list.
 * A refusal moves that call to Chat Completions and tells the caller, who
 * stores the model's API, so the next call starts there and an admin sees it.
 */
const streamFor = (connection: Connection, call: ModelCall) => {
  const format = formatFor(connection.preset, connection.settings, call.model, call.format);
  // Replay state is stamped with the format that produced it, so each route
  // is a connection of that format in every respect.
  const as = (next: typeof format): Connection => ({
    ...connection,
    settings: { ...connection.settings, format: next },
  });
  if (format === "messages")
    return (options: LanguageModel.ProviderOptions) => streamMessages(as(format), call, options);
  if (format === "chat-completions")
    return (options: LanguageModel.ProviderOptions) => streamChat(as(format), call, options);
  return (options: LanguageModel.ProviderOptions) =>
    streamResponses(as(format), call, options).pipe(
      Stream.catchIf(
        (error) => connection.preset.modelFormat === true && isModelNotSupported(error),
        () =>
          Stream.fromEffect(call.onChatFallback ?? Effect.void).pipe(
            Stream.flatMap(() => streamChat(as("chat-completions"), call, options)),
          ),
      ),
    );
};

/**
 * Folds a streamed round into complete parts. Every call streams: one-shot
 * response schemas demand fields plain servers omit, and one code path is one
 * set of quirks.
 */
export const foldParts = (parts: ReadonlyArray<StreamPart>) =>
  Effect.gen(function* () {
    const out: Response.PartEncoded[] = [];
    const open = new Map<
      string,
      { type: "text" | "reasoning"; text: string; metadata?: Response.ProviderMetadata }
    >();
    for (const part of parts) {
      switch (part.type) {
        case "text-start":
        case "reasoning-start":
          open.set(part.id, { type: part.type === "text-start" ? "text" : "reasoning", text: "" });
          break;
        case "text-delta":
        case "reasoning-delta": {
          const block = open.get(part.id);
          if (block) block.text += part.delta;
          break;
        }
        case "text-end":
        case "reasoning-end": {
          const block = open.get(part.id);
          if (!block) break;
          open.delete(part.id);
          out.push({
            type: block.type,
            text: block.text,
            ...(part.metadata ? { metadata: part.metadata } : {}),
          });
          break;
        }
        case "error":
          return yield* Effect.fail(
            AiError.make({
              module: MODULE,
              method: "generateText",
              reason: new AiError.InternalProviderError({
                description:
                  typeof (part.error as { message?: unknown } | null)?.message === "string"
                    ? (part.error as { message: string }).message
                    : "The provider reported an error",
              }),
            }),
          );
        case "tool-params-start":
        case "tool-params-delta":
        case "tool-params-end":
          break;
        default:
          out.push(part as Response.PartEncoded);
      }
    }
    return out;
  });

export const make = (connection: Connection, call: ModelCall) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const base = streamFor(connection, call);
    const stream = (options: LanguageModel.ProviderOptions) =>
      base(options).pipe(Stream.provideService(HttpClient.HttpClient, http));
    return yield* LanguageModel.make({
      streamText: stream,
      generateText: (options) =>
        stream(options).pipe(
          Stream.runCollect,
          Effect.flatMap((parts) => foldParts(Array.from(parts))),
        ),
    });
  });

/** The LanguageModel for one model on one connection, with this call's settings. */
export const layer = (
  connection: Connection,
  call: ModelCall,
): Layer.Layer<LanguageModel.LanguageModel, never, HttpClient.HttpClient> =>
  Layer.effect(LanguageModel.LanguageModel, make(connection, call));
