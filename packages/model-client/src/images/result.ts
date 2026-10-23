import { Effect, Result } from "effect";
import type { AiError } from "effect/ai";
import { invalidOutput } from "../errors.ts";
import { decodeImage } from "./bytes.ts";
import { isRecord, num, str } from "./http.ts";

export interface ImageUsage {
  readonly inputTokens: number;
  readonly textInputTokens?: number;
  readonly imageInputTokens?: number;
  readonly outputTokens: number;
}

export interface GeneratedImage {
  readonly mediaType: string;
  readonly data: Uint8Array;
}

interface Billing {
  readonly usage?: ImageUsage;
  readonly cost?: number;
  /**
   * Some requests of a batch failed or did not report their billing, so
   * `usage` and `cost` cover only the ones that did.
   */
  readonly incomplete?: true;
  /** How many calls answered, when a batch was made one image per call. */
  readonly requests?: number;
}

export type ImageResult =
  | (Billing & {
      readonly kind: "images";
      readonly images: ReadonlyArray<GeneratedImage>;
      readonly revisedPrompt?: string;
      /** Why a batch made fewer images than it asked for, in one sentence. */
      readonly shortfall?: string;
    })
  | (Billing & { readonly kind: "refused"; readonly message: string })
  /** The provider answered, and may have billed, but what it sent cannot be used. */
  | (Billing & { readonly kind: "unusable"; readonly message: string });

const optional = <K extends string, V>(key: K, value: V | undefined) =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

export const imagesResult = (input: {
  readonly images: ReadonlyArray<GeneratedImage>;
  readonly revisedPrompt?: string | undefined;
  readonly usage?: ImageUsage | undefined;
  readonly cost?: number | undefined;
}): ImageResult => ({
  kind: "images",
  images: input.images,
  ...optional("revisedPrompt", input.revisedPrompt),
  ...optional("usage", input.usage),
  ...optional("cost", input.cost),
});

export const refusedResult = (
  message: string,
  extra: { readonly usage?: ImageUsage | undefined; readonly cost?: number | undefined } = {},
): ImageResult => ({
  kind: "refused",
  message,
  ...optional("usage", extra.usage),
  ...optional("cost", extra.cost),
});

export const noImages = () => invalidOutput("The image provider returned no image");

/**
 * Reads a reply whose billing is already known. Output that fails validation
 * becomes `unusable` with that billing, so the ledger keeps what was charged
 * instead of losing it with the error.
 */
export const decodedOrUnusable = <R>(
  billing: { readonly usage?: ImageUsage | undefined; readonly cost?: number | undefined },
  decode: Effect.Effect<ImageResult, AiError.AiError, R>,
): Effect.Effect<ImageResult, AiError.AiError, R> =>
  billing.usage === undefined && billing.cost === undefined
    ? decode
    : decode.pipe(
        Effect.catch((error) =>
          error.reason._tag === "InvalidOutputError"
            ? Effect.succeed<ImageResult>({
                kind: "unusable",
                message: error.reason.description ?? "The image provider sent an unusable image.",
                ...optional("usage", billing.usage),
                ...optional("cost", billing.cost),
              })
            : Effect.fail(error),
        ),
      );

/**
 * The OpenAI-style `data` array: base64 only. A URL is refused rather than
 * fetched, since following it would let a provider point the server anywhere.
 */
export const decodeDataArray = (value: unknown) =>
  Effect.gen(function* () {
    const entries = Array.isArray(value) ? value.filter(isRecord) : [];
    if (entries.length === 0) return yield* Effect.fail(noImages());
    const images: GeneratedImage[] = [];
    for (const entry of entries) {
      const encoded = str(entry["b64_json"]);
      if (!encoded) {
        if (str(entry["url"]))
          return yield* Effect.fail(
            invalidOutput("The image provider returned a URL; base64 image data is required"),
          );
        return yield* Effect.fail(noImages());
      }
      images.push(
        yield* decodeImage(encoded, str(entry["media_type"]) ?? str(entry["mime_type"]) ?? null),
      );
    }
    const revised = entries.map((entry) => str(entry["revised_prompt"])).find(Boolean);
    return { images, revisedPrompt: revised };
  });

/** OpenAI's image usage: input tokens split into text and image, then output tokens. */
export const openAiUsage = (value: unknown): ImageUsage | undefined => {
  if (!isRecord(value)) return undefined;
  const input = num(value["input_tokens"]) ?? num(value["prompt_tokens"]);
  const output = num(value["output_tokens"]) ?? num(value["completion_tokens"]);
  if (input === undefined || output === undefined) return undefined;
  const details = isRecord(value["input_tokens_details"]) ? value["input_tokens_details"] : {};
  return {
    inputTokens: input,
    outputTokens: output,
    ...optional("textInputTokens", num(details["text_tokens"])),
    ...optional("imageInputTokens", num(details["image_tokens"])),
  };
};

const total = (values: ReadonlyArray<number | undefined>) =>
  values.some((value) => value !== undefined)
    ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : undefined;

/**
 * Runs `count` single-image calls and joins them. A failed call drops only its
 * own image: the others were drawn and paid for, so the batch fails only when
 * every call did. `deadline` bounds each call on its own, so one that hangs
 * cannot take the finished ones with it. Usage and cost sum what was reported,
 * and are `incomplete` when any call failed or left its own unreported.
 */
export const repeated = <E, R>(
  count: number,
  once: Effect.Effect<ImageResult, E, R>,
  deadline: <A>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> = (effect) => effect,
) =>
  Effect.gen(function* () {
    if (count <= 1) return yield* deadline(once);
    const settled = yield* Effect.all(
      Array.from({ length: count }, () => Effect.result(deadline(once))),
      { concurrency: count },
    );
    const results = settled.flatMap((result) => (Result.isSuccess(result) ? [result.success] : []));
    const failed = settled.filter(Result.isFailure);
    if (results.length === 0 && failed[0]) return yield* Effect.fail(failed[0].failure);
    const usages = results.flatMap((result) => (result.usage ? [result.usage] : []));
    const costs = results.map((result) => result.cost);
    const usage =
      usages.length > 0
        ? {
            inputTokens: usages.reduce((sum, value) => sum + value.inputTokens, 0),
            outputTokens: usages.reduce((sum, value) => sum + value.outputTokens, 0),
            ...optional(
              "textInputTokens",
              usages.every((value) => value.textInputTokens !== undefined)
                ? total(usages.map((value) => value.textInputTokens))
                : undefined,
            ),
            ...optional(
              "imageInputTokens",
              usages.every((value) => value.imageInputTokens !== undefined)
                ? total(usages.map((value) => value.imageInputTokens))
                : undefined,
            ),
          }
        : undefined;
    const cost = total(costs);
    // Known so far is kept; what any call left unknown makes it a lower bound.
    const partly = (known: number) => known > 0 && known < results.length;
    const billing = {
      ...optional("usage", usage),
      ...optional("cost", cost),
      // Each call sent the references again, and a fee per reference is charged per call.
      requests: results.length,
      ...(failed.length > 0 ||
      results.some((result) => result.incomplete) ||
      partly(usages.length) ||
      partly(costs.filter((value) => value !== undefined).length)
        ? { incomplete: true as const }
        : {}),
    };
    const drawn = results.flatMap((result) => (result.kind === "images" ? [result] : []));
    const reasons = [
      ...results.flatMap((result) => (result.kind === "images" ? [] : [result.message])),
      ...failed.flatMap((result) =>
        result.failure && typeof result.failure === "object" && "message" in result.failure
          ? [String(result.failure.message)]
          : [],
      ),
    ];
    if (drawn.length === 0) {
      // A refusal says more than an unusable answer, so it wins.
      const refused = results.find((result) => result.kind === "refused");
      return refused?.kind === "refused"
        ? ({ kind: "refused", message: refused.message, ...billing } satisfies ImageResult)
        : ({ kind: "unusable", message: reasons[0] ?? "", ...billing } satisfies ImageResult);
    }
    const missing = count - drawn.length;
    return {
      kind: "images",
      images: drawn.flatMap((result) => result.images),
      ...optional("revisedPrompt", drawn.map((result) => result.revisedPrompt).find(Boolean)),
      ...optional(
        "shortfall",
        missing > 0
          ? `${missing} of ${count} images were not made: ${reasons[0]?.slice(0, 200) || "the provider failed."}`
          : undefined,
      ),
      ...billing,
    } satisfies ImageResult;
  });
