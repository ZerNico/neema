/**
 * OpenRouter's Images API (`POST /images`), which answers base64 with the
 * cost in USD. Chat Completions' `modalities` stays the native output path;
 * this one serves image models, image-only ones included.
 */

import { Effect } from "effect";
import { endpoint, type Connection } from "../connection.ts";
import { dataUri } from "./bytes.ts";
import { isRecord, num, post } from "./http.ts";
import type { NormalizedImageRequest } from "./normalize.ts";
import type { AiError } from "effect/unstable/ai";
import type { HttpClient } from "effect/unstable/http";
import {
  decodeDataArray,
  decodedOrUnusable,
  imagesResult,
  openAiUsage,
  refusedResult,
  repeated,
} from "./result.ts";

export const openRouterImages = (
  connection: Connection,
  model: string,
  request: NormalizedImageRequest,
  deadline?: <A>(
    effect: Effect.Effect<A, AiError.AiError, HttpClient.HttpClient>,
  ) => Effect.Effect<A, AiError.AiError, HttpClient.HttpClient>,
) =>
  repeated(
    request.count,
    Effect.gen(function* () {
      const reply = yield* post(connection, {
        url: endpoint(connection, "/images"),
        body: {
          model,
          prompt: request.prompt,
          aspect_ratio: request.aspectRatio,
          ...(request.quality ? { quality: request.quality } : {}),
          ...(request.background ? { background: request.background } : {}),
          ...(request.background === "transparent" ? { output_format: "png" } : {}),
          ...(request.references.length > 0
            ? {
                input_references: request.references.map((reference) => ({
                  type: "image_url",
                  image_url: { url: dataUri(reference) },
                })),
              }
            : {}),
        },
        images: 1,
      });
      if (reply.kind === "refused") return refusedResult(reply.message);
      const usage = reply.value["usage"];
      const billing = {
        usage: openAiUsage(usage),
        cost: isRecord(usage) ? num(usage["cost"]) : undefined,
      };
      return yield* decodedOrUnusable(
        billing,
        decodeDataArray(reply.value["data"]).pipe(
          Effect.map((decoded) => imagesResult({ ...decoded, ...billing })),
        ),
      );
    }),
    deadline,
  );
