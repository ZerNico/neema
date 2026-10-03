import type { Schema } from "effect";
import { Prompt, type Response } from "effect/unstable/ai";
import type { WireFormat } from "./preset.ts";

/**
 * Who produced a replay unit. Opaque reasoning state is only ever sent back to
 * the same service, endpoint, wire format and model: anywhere else it is
 * meaningless at best and rejected at worst. No credentials are part of it.
 */
export type ReplayIdentity = {
  readonly provider: string;
  readonly baseUrl: string;
  readonly format: WireFormat;
  readonly model: string;
};

/**
 * Everything one model round returned that the next request must send back
 * exactly as received, in order. Readable text stays in the transcript; this
 * holds only what a provider needs to continue its own reasoning.
 */
export type ReplayUnit =
  | {
      readonly v: 1;
      readonly id: string;
      readonly identity: ReplayIdentity;
      readonly format: "chat-completions";
      /** OpenRouter-style `reasoning_details`, consecutive text deltas merged. */
      readonly reasoningDetails?: ReadonlyArray<Schema.Json>;
      /** The reasoning text, for services that want it back as `reasoning_content`. */
      readonly reasoningContent?: string;
      /** Per tool call id, the call's provider extras (Gemini thought signatures). */
      readonly callExtras?: { readonly [callId: string]: Schema.Json };
    }
  | {
      readonly v: 1;
      readonly id: string;
      readonly identity: ReplayIdentity;
      readonly format: "responses";
      /** Output items as received: reasoning with encrypted content, messages with phase, calls. */
      readonly items: ReadonlyArray<Schema.Json>;
    };

/** The key replay state travels under in part metadata and prompt options. */
export const METADATA_KEY = "modelClient";

/** Opaque state larger than this is not kept: it would be resent on every request. */
export const MAX_REPLAY_BYTES = 1_000_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isIdentity = (value: unknown): value is ReplayIdentity =>
  isRecord(value) &&
  typeof value["provider"] === "string" &&
  typeof value["baseUrl"] === "string" &&
  typeof value["model"] === "string" &&
  (value["format"] === "chat-completions" || value["format"] === "responses");

/** Reads a replay unit from untrusted JSON, or nothing when it is not one. */
export const decodeReplayUnit = (value: unknown): ReplayUnit | undefined => {
  if (!isRecord(value) || value["v"] !== 1 || typeof value["id"] !== "string") return undefined;
  if (!isIdentity(value["identity"])) return undefined;
  if (value["format"] === "responses")
    return Array.isArray(value["items"]) ? (value as ReplayUnit) : undefined;
  if (value["format"] !== "chat-completions") return undefined;
  if (value["reasoningDetails"] !== undefined && !Array.isArray(value["reasoningDetails"]))
    return undefined;
  if (value["reasoningContent"] !== undefined && typeof value["reasoningContent"] !== "string")
    return undefined;
  if (value["callExtras"] !== undefined && !isRecord(value["callExtras"])) return undefined;
  return value as ReplayUnit;
};

/** The replay unit carried by a part's metadata or a prompt part's or message's options. */
export const replayOf = (options: unknown): ReplayUnit | undefined => {
  if (!isRecord(options)) return undefined;
  const own = options[METADATA_KEY];
  return isRecord(own) ? decodeReplayUnit(own["replay"]) : undefined;
};

export const sameIdentity = (a: ReplayIdentity, b: ReplayIdentity) =>
  a.provider === b.provider &&
  a.baseUrl === b.baseUrl &&
  a.format === b.format &&
  a.model === b.model;

/** Whether a unit holds anything a provider needs back. */
export const isEmptyUnit = (unit: ReplayUnit) =>
  unit.format === "responses"
    ? unit.items.length === 0
    : (unit.reasoningDetails?.length ?? 0) === 0 &&
      !unit.reasoningContent &&
      Object.keys(unit.callExtras ?? {}).length === 0;

/** The units in an assistant message, in order, each once. */
export const unitsOfMessage = (message: Prompt.AssistantMessage): ReadonlyArray<ReplayUnit> => {
  const seen = new Set<string>();
  const units: ReplayUnit[] = [];
  const add = (unit: ReplayUnit | undefined) => {
    if (!unit || seen.has(unit.id)) return;
    seen.add(unit.id);
    units.push(unit);
  };
  add(replayOf(message.options));
  for (const part of message.content) add(replayOf(part.options));
  return units;
};

/**
 * Whether a provider error for this prompt could quote something private: image
 * bytes, or opaque reasoning state the provider may echo back in a rejection.
 */
export const isSensitivePrompt = (prompt: Prompt.Prompt): boolean =>
  prompt.content.some(
    (message) =>
      (message.role === "assistant" &&
        unitsOfMessage(message).some((unit) => !isEmptyUnit(unit))) ||
      (message.role !== "system" &&
        message.content.some(
          (part) => part.type === "file" && part.mediaType.startsWith("image/"),
        )),
  );

/**
 * One model round as the prompt that continues it: text, reasoning and files in
 * the order they streamed, then the calls, with the round's replay unit on the
 * assistant message. `Prompt.fromResponseParts` would drop the files' positions
 * and the finish part's state.
 */
export const roundPrompt = (parts: ReadonlyArray<Response.AnyPart>): Prompt.Prompt => {
  const assistant: Array<Prompt.AssistantMessagePart> = [];
  const tools: Array<Prompt.Message> = [];
  let unit: ReplayUnit | undefined;
  for (const part of parts) {
    if (
      part.type === "text" ||
      part.type === "text-delta" ||
      part.type === "reasoning" ||
      part.type === "reasoning-delta"
    ) {
      const type = part.type.startsWith("text") ? "text" : "reasoning";
      const text = "delta" in part ? part.delta : part.text;
      const previous = assistant.at(-1);
      if (previous?.type === type)
        assistant[assistant.length - 1] = Prompt.makePart(type, { text: previous.text + text });
      else assistant.push(Prompt.makePart(type, { text }));
    } else if (part.type === "file") {
      assistant.push(Prompt.makePart("file", { mediaType: part.mediaType, data: part.data }));
    } else if (part.type === "finish") {
      unit = replayOf(part.metadata) ?? unit;
    } else if (
      part.type === "tool-call" ||
      part.type === "tool-result" ||
      part.type === "tool-approval-request"
    ) {
      for (const message of Prompt.fromResponseParts([part]).content) {
        if (message.role === "assistant") assistant.push(...message.content);
        else tools.push(message);
      }
    }
  }
  return Prompt.make([
    ...(assistant.length > 0
      ? [
          Prompt.makeMessage("assistant", {
            content: assistant,
            ...(unit && !isEmptyUnit(unit)
              ? { options: { [METADATA_KEY]: { replay: unit } } }
              : {}),
          }),
        ]
      : []),
    ...tools,
  ]);
};
