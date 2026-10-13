/**
 * OpenAI's Images API, as OpenAI, Azure's `/openai/v1`, Vercel and
 * OpenAI-compatible servers serve it: JSON generations, multipart edits.
 */

import { Effect, Option, Stream } from "effect";
import { endpoint, type Connection } from "../connection.ts";
import { invalidOutput } from "../errors.ts";
import { decodeImage } from "./bytes.ts";
import type { ImageFamily } from "./families.ts";
import { isRecord, num, post, postEvents, refusalByCode, str } from "./http.ts";
import type { NormalizedImageRequest } from "./normalize.ts";
import {
  decodeDataArray,
  decodedOrUnusable,
  imagesResult,
  noImages,
  openAiUsage,
  refusedResult,
  type GeneratedImage,
  type ImageResult,
} from "./result.ts";

type OpenAiFamily = "gpt-image" | "dall-e-3" | "dall-e-2" | "openai-compatible-image";

/** GPT Image refuses `response_format` and always answers base64; older shapes need asking. */
const askForBase64 = (family: OpenAiFamily) => family !== "gpt-image";

const fields = (
  family: OpenAiFamily,
  model: string,
  request: NormalizedImageRequest,
): Record<string, string | number> => ({
  model,
  prompt: request.prompt,
  n: request.count,
  ...(request.size ? { size: request.size } : {}),
  ...(family === "dall-e-3" && request.quality
    ? { quality: request.quality === "high" ? "hd" : "standard" }
    : {}),
  ...(family === "gpt-image" && request.quality ? { quality: request.quality } : {}),
  ...(family === "gpt-image" && request.background ? { background: request.background } : {}),
  // Transparency needs a format with alpha.
  ...(family === "gpt-image" && request.background === "transparent"
    ? { output_format: "png" }
    : {}),
  ...(askForBase64(family) ? { response_format: "b64_json" } : {}),
});

const editForm = (family: OpenAiFamily, model: string, request: NormalizedImageRequest) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields(family, model, request)))
    form.append(key, String(value));
  // DALL-E 2 and most compatible servers take one `image`; GPT Image takes `image[]`.
  const key = family === "gpt-image" || request.references.length > 1 ? "image[]" : "image";
  for (const reference of request.references)
    form.append(
      key,
      new Blob([new Uint8Array(reference.bytes)], { type: reference.mediaType }),
      reference.name,
    );
  return form;
};

/** How many in-progress images GPT Image streams before the finished one. */
const PARTIAL_IMAGES = 2;

/** A partial image, sniffed like the final one; it is shown, never stored. */
export type OnPartial = (
  partial: GeneratedImage & { readonly index: number },
) => Effect.Effect<void>;

/**
 * GPT Image streamed: partial images as it draws, then the finished one with
 * its usage. Only one image per call streams, so a batch is not offered this.
 */
const streamed = (
  connection: Connection,
  model: string,
  request: NormalizedImageRequest,
  onPartial: OnPartial,
) =>
  Effect.gen(function* () {
    const edit = request.references.length > 0;
    const extra = { stream: "true", partial_images: String(PARTIAL_IMAGES) };
    const body = edit
      ? (() => {
          const form = editForm("gpt-image", model, request);
          for (const [key, value] of Object.entries(extra)) form.append(key, value);
          return form;
        })()
      : { ...fields("gpt-image", model, request), stream: true, partial_images: PARTIAL_IMAGES };
    const opened = yield* postEvents(connection, {
      url: endpoint(connection, edit ? "/images/edits" : "/images/generations"),
      body,
      images: 1,
      refusal: refusalByCode(["moderation_blocked", "content_policy_violation"]),
    });
    if (opened.kind === "refused") return refusedResult(opened.message);
    if (opened.kind === "json") return yield* fromData(opened.value);
    // Read until the finished image; a stream left open after it is not waited on.
    const final = yield* opened.events.pipe(
      Stream.mapEffect((event) =>
        Effect.gen(function* () {
          const type = str(event["type"]) ?? "";
          if (type === "error" || isRecord(event["error"])) {
            const error = isRecord(event["error"]) ? event["error"] : event;
            const code = str(error["code"]);
            const message = str(error["message"]) ?? "The image provider failed.";
            if (code === "moderation_blocked" || code === "content_policy_violation")
              return Option.some(refusedResult(message));
            return yield* Effect.fail(invalidOutput(message));
          }
          const encoded = str(event["b64_json"]);
          if (type.endsWith(".partial_image")) {
            // A preview that does not decode is skipped; only the finished image counts.
            if (!encoded) return Option.none<ImageResult>();
            const image = yield* decodeImage(encoded, null).pipe(Effect.option);
            if (Option.isSome(image))
              yield* onPartial({ ...image.value, index: num(event["partial_image_index"]) ?? 0 });
            return Option.none<ImageResult>();
          }
          if (!type.endsWith(".completed")) return Option.none<ImageResult>();
          // Usage first: a completion without a readable image was still billed.
          const usage = openAiUsage(event["usage"]);
          return Option.some(
            yield* decodedOrUnusable(
              { usage },
              (encoded ? decodeImage(encoded, null) : Effect.fail(noImages())).pipe(
                Effect.map((image) => imagesResult({ images: [image], usage })),
              ),
            ),
          );
        }),
      ),
      Stream.filter(Option.isSome),
      Stream.map((result) => result.value),
      Stream.runHead,
    );
    return Option.isSome(final) ? final.value : yield* Effect.fail(noImages());
  });

const fromData = (value: Record<string, unknown>) => {
  const usage = openAiUsage(value["usage"]);
  return decodedOrUnusable(
    { usage },
    decodeDataArray(value["data"]).pipe(
      Effect.map((decoded) => imagesResult({ ...decoded, usage })),
    ),
  );
};

export const openAiImages = (
  connection: Connection,
  family: OpenAiFamily,
  model: string,
  request: NormalizedImageRequest,
  onPartial?: OnPartial,
) =>
  Effect.gen(function* () {
    if (onPartial && family === "gpt-image" && request.count === 1)
      return yield* streamed(connection, model, request, onPartial);
    const edit = request.references.length > 0;
    const reply = yield* post(connection, {
      url: endpoint(connection, edit ? "/images/edits" : "/images/generations"),
      body: edit ? editForm(family, model, request) : fields(family, model, request),
      images: request.count,
      refusal: refusalByCode(["moderation_blocked", "content_policy_violation"]),
    });
    if (reply.kind === "refused") return refusedResult(reply.message);
    return yield* fromData(reply.value);
  });

export const isOpenAiFamily = (family: ImageFamily): family is OpenAiFamily =>
  family === "gpt-image" ||
  family === "dall-e-3" ||
  family === "dall-e-2" ||
  family === "openai-compatible-image";
