/**
 * xAI's Imagine API: OpenAI-like paths with its own body. Edits are JSON with
 * references as data URIs, one `image` or an `images` list.
 */

import { Effect } from "effect";
import { endpoint, type Connection } from "../connection.ts";
import { dataUri } from "./bytes.ts";
import { post } from "./http.ts";
import type { NormalizedImageRequest } from "./normalize.ts";
import {
  decodeDataArray,
  decodedOrUnusable,
  imagesResult,
  openAiUsage,
  refusedResult,
} from "./result.ts";

export const xaiImages = (connection: Connection, model: string, request: NormalizedImageRequest) =>
  Effect.gen(function* () {
    const references = request.references.map((reference) => ({
      type: "image_url",
      url: dataUri(reference),
    }));
    const edit = references.length > 0;
    const reply = yield* post(connection, {
      url: endpoint(connection, edit ? "/images/edits" : "/images/generations"),
      body: {
        model,
        prompt: request.prompt,
        n: request.count,
        aspect_ratio: request.aspectRatio,
        ...(request.quality ? { quality: request.quality } : {}),
        response_format: "b64_json",
        ...(references.length === 1 ? { image: references[0] } : {}),
        ...(references.length > 1 ? { images: references } : {}),
      },
      images: request.count,
    });
    if (reply.kind === "refused") return refusedResult(reply.message);
    const usage = openAiUsage(reply.value["usage"]);
    return yield* decodedOrUnusable(
      { usage },
      decodeDataArray(reply.value["data"]).pipe(
        Effect.map((decoded) => imagesResult({ ...decoded, usage })),
      ),
    );
  });
