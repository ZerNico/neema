/**
 * Gemini image models on the native `generateContent` API, beside the
 * OpenAI-compatible base the preset uses for chat. The key goes in
 * `x-goog-api-key`: the native API reads a bearer token as OAuth.
 */

import { Effect } from "effect";
import type { AiError } from "effect/ai";
import type { HttpClient } from "effect/http";
import type { Connection } from "../connection.ts";
import { toBase64, decodeImage } from "./bytes.ts";
import { isRecord, num, post, str } from "./http.ts";
import type { NormalizedImageRequest } from "./normalize.ts";
import {
  decodedOrUnusable,
  imagesResult,
  noImages,
  refusedResult,
  repeated,
  type GeneratedImage,
  type ImageUsage,
} from "./result.ts";

/** Finish reasons that mean the provider declined, as opposed to failing. */
const DECLINED = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
  "IMAGE_OTHER",
  "NO_IMAGE",
]);

export const nativeBaseUrl = (connection: Connection) =>
  connection.baseUrl.replace(/\/+$/, "").replace(/\/openai$/, "");

const usageOf = (value: unknown): ImageUsage | undefined => {
  if (!isRecord(value)) return undefined;
  const input = num(value["promptTokenCount"]);
  const output = num(value["candidatesTokenCount"]);
  if (input === undefined || output === undefined) return undefined;
  const details = Array.isArray(value["promptTokensDetails"])
    ? value["promptTokensDetails"].filter(isRecord)
    : [];
  const modality = (name: string) =>
    details.find((detail) => detail["modality"] === name)?.["tokenCount"];
  const text = num(modality("TEXT"));
  const image = num(modality("IMAGE"));
  return {
    inputTokens: input,
    // Thinking is billed as output.
    outputTokens: output + (num(value["thoughtsTokenCount"]) ?? 0),
    ...(text === undefined ? {} : { textInputTokens: text }),
    ...(image === undefined ? {} : { imageInputTokens: image }),
  };
};

const once = (connection: Connection, model: string, request: NormalizedImageRequest) =>
  Effect.gen(function* () {
    const keyed: Connection = {
      ...connection,
      settings: { ...connection.settings, keyHeader: "x-goog-api-key" },
    };
    const reply = yield* post(keyed, {
      url: `${nativeBaseUrl(connection)}/models/${model.replace(/^models\//, "")}:generateContent`,
      body: {
        contents: [
          {
            role: "user",
            parts: [
              { text: request.prompt },
              ...request.references.map((reference) => ({
                inlineData: { mimeType: reference.mediaType, data: toBase64(reference.bytes) },
              })),
            ],
          },
        ],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: { aspectRatio: request.aspectRatio },
        },
      },
      images: 1,
    });
    if (reply.kind === "refused") return refusedResult(reply.message);
    const usage = usageOf(reply.value["usageMetadata"]);
    const feedback = isRecord(reply.value["promptFeedback"]) ? reply.value["promptFeedback"] : {};
    const blocked = str(feedback["blockReason"]);
    if (blocked)
      return refusedResult(
        str(feedback["blockReasonMessage"]) ?? `The provider blocked the prompt (${blocked}).`,
        { usage },
      );
    const candidates = Array.isArray(reply.value["candidates"])
      ? reply.value["candidates"].filter(isRecord)
      : [];
    const candidate = candidates[0] ?? {};
    const content = isRecord(candidate["content"]) ? candidate["content"] : {};
    // Thought parts carry drafts, not the answer.
    const parts = (Array.isArray(content["parts"]) ? content["parts"].filter(isRecord) : []).filter(
      (part) => part["thought"] !== true,
    );
    // Usage is known by now; an image that cannot be read keeps it for the ledger.
    return yield* decodedOrUnusable(
      { usage },
      Effect.gen(function* () {
        const images: GeneratedImage[] = [];
        for (const part of parts) {
          const inline = part["inlineData"] ?? part["inline_data"];
          if (!isRecord(inline)) continue;
          const data = str(inline["data"]);
          if (data)
            images.push(yield* decodeImage(data, str(inline["mimeType"] ?? inline["mime_type"])));
        }
        const text = parts
          .map((part) => str(part["text"]) ?? "")
          .join("")
          .trim();
        if (images.length > 0)
          return imagesResult({ images, revisedPrompt: text || undefined, usage });
        const reason = str(candidate["finishReason"]);
        if (text || (reason && DECLINED.has(reason)))
          return refusedResult(
            text || (str(candidate["finishMessage"]) ?? `The provider made no image (${reason}).`),
            { usage },
          );
        return yield* Effect.fail(noImages());
      }),
    );
  });

export const geminiImages = (
  connection: Connection,
  model: string,
  request: NormalizedImageRequest,
  deadline?: <A>(
    effect: Effect.Effect<A, AiError.AiError, HttpClient.HttpClient>,
  ) => Effect.Effect<A, AiError.AiError, HttpClient.HttpClient>,
) => repeated(request.count, once(connection, model, request), deadline);
