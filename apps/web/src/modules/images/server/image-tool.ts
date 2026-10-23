import { Effect, Exit, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { FetchHttpClient } from "effect/http";
import {
  ASPECT_RATIOS,
  IMAGE_QUALITIES,
  effectiveImageCapabilities,
  generateImages,
  imageFamily,
  normalizeImageRequest,
  type Connection,
  type ImageCapabilities,
  type ImageFamily,
  type ImageReference,
  type ImageResult,
  type NormalizedImageRequest,
} from "@chat/model-client";
import type { CostSource } from "~/db/schema/analytics.ts";
import type { ImagePricing } from "~/modules/providers/model-config.ts";
import type { ToolFile } from "~/modules/chat/server/tool-files.ts";
import { advertisedParameter, type ToolGroup } from "~/modules/tools/server/toolset.ts";
import { IMAGE_TOOL, type ImageCallShape } from "../tool-schema.ts";

/** The image model one attempt resolved, loaded once before its toolkit is built. */
export interface ImageModelDescriptor {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly modelKey: string;
  readonly family: ImageFamily;
  readonly capabilities: ImageCapabilities;
  readonly pricing: ImagePricing | null;
  readonly connection: Connection;
}

/** One image operation as the ledger records it, written once whatever happened. */
export interface ImageOperation {
  /** The call's row; null only when the answer ended before the row existed. */
  readonly toolCallId: string | null;
  readonly status: "complete" | "error" | "aborted";
  readonly images: number;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly complete: boolean;
  };
  readonly cost: number | null;
  readonly costSource: CostSource | null;
}

/** An in-progress image a streaming model sent; shown while it draws, never stored. */
export interface ImagePreview {
  readonly mediaType: string;
  readonly data: Uint8Array;
  readonly index: number;
}

export interface StagedImages {
  readonly images: ReadonlyArray<{ readonly mediaType: string; readonly data: Uint8Array }>;
  /** File names without extension, one per image, so a reader can tell them apart. */
  readonly stem: string;
  /** Reserved slots the delivery did not use go back to the answer's budget. */
  readonly settle: (delivered: number) => void;
}

// Words that say nothing about the picture when a name is cut from its prompt.
const FILLER = new Set(
  "a an the of on in at to with and or for from by into onto over under is are this that its image picture photo".split(
    " ",
  ),
);

const words = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * A file name stem for a call's images: the model's own name when it gave one,
 * else the first words of the prompt that describe something.
 */
export const imageFileStem = (name: unknown, prompt: string): string => {
  const given = typeof name === "string" ? words(name.replace(/\.[a-z0-9]{2,4}$/i, "")) : [];
  const chosen = given.length
    ? given
    : words(prompt)
        .filter((word) => !FILLER.has(word))
        .slice(0, 4);
  // By code point: a UTF-16 cut could leave half of a character outside the basic plane.
  return Array.from(chosen.join("-")).slice(0, 60).join("").replace(/-+$/, "") || "image";
};

/**
 * The answer's image slots, shared by every call of one attempt. Calls run in
 * parallel ahead of the consumer, so a call reserves before it spends and
 * hands back what it did not use.
 */
export const makeImageBudget = (held: number, limit: number) => {
  let used = held;
  return {
    reserve: (wanted: number) => {
      const granted = Math.max(0, Math.min(wanted, limit - used));
      used += granted;
      return granted;
    },
    release: (count: number) => {
      used = Math.max(0, used - count);
    },
  };
};
export type ImageBudget = ReturnType<typeof makeImageBudget>;

const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;

const tool = Tool.make(IMAGE_TOOL, {
  description:
    "Create an image with the image model the person chose, or edit images by passing them as references. Write a detailed visual prompt: subject, composition, style, lighting, any text to render. References are files in this chat or project: an attachment id, an `attachment:`/`project:` reference, a project file name, or a `/api/files/<id>` link. The images are shown to the person as part of your answer, so do not repeat them as links.",
  parameters: Schema.Struct({
    prompt: advertisedParameter({
      type: "string",
      description: "What to draw, or how to change the references.",
    }),
    references: advertisedParameter({
      type: "array",
      items: { type: "string" },
      description: "Images to edit or draw from. Omit to create from the prompt alone.",
    }),
    aspect_ratio: advertisedParameter({ type: "string", enum: [...ASPECT_RATIOS] }),
    quality: advertisedParameter({
      type: "string",
      enum: [...IMAGE_QUALITIES],
      description:
        "Leave unset unless the person asks. Low suits drafts; high suits fine detail or text and costs more.",
    }),
    background: advertisedParameter({ type: "string", enum: ["auto", "transparent", "opaque"] }),
    name: advertisedParameter({
      type: "string",
      description: "A short file name for the image, a few words, without an extension.",
    }),
    count: advertisedParameter({
      type: "integer",
      minimum: 1,
      maximum: 4,
      description:
        "Variations of this one prompt. For different ideas or styles, make separate calls.",
    }),
  }),
  success: Schema.Struct({
    ok: Schema.Boolean,
    model: Schema.optionalKey(Schema.String),
    images: Schema.optionalKey(Schema.Int),
    quality: Schema.optionalKey(Schema.Literals(IMAGE_QUALITIES)),
    adjustments: Schema.optionalKey(Schema.Array(Schema.String)),
    revisedPrompt: Schema.optionalKey(Schema.String),
    refusal: Schema.optionalKey(Schema.String),
    error: Schema.optionalKey(Schema.String),
    /** Set by the engine once the images are stored. */
    attachmentIds: Schema.optionalKey(Schema.Array(Schema.String)),
    files: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  failureMode: "return",
});

const oneOf = <T extends string>(values: ReadonlyArray<T>, value: unknown): T | undefined =>
  typeof value === "string" && (values as ReadonlyArray<string>).includes(value)
    ? (value as T)
    : undefined;

/**
 * Cost of one operation: the provider's own figure, else token prices when the
 * API reported usage, else the per-image price, either plus the fees per reference
 * each call sent. A fee alone is not the cost, so that stays unknown.
 */
export const imageCost = (
  pricing: ImagePricing | null,
  request: Pick<NormalizedImageRequest, "quality"> & {
    readonly qualities: ReadonlyArray<string>;
    readonly references: number;
  },
  result: Pick<ImageResult, "cost" | "usage" | "requests"> & { readonly images: number },
): { cost: number | null; costSource: CostSource | null } => {
  if (result.cost !== undefined) return { cost: result.cost, costSource: "provider" };
  const fees = (pricing?.perReference ?? 0) * request.references * (result.requests ?? 1);
  if (pricing?.tokens && result.usage) {
    const image = result.usage.imageInputTokens ?? 0;
    const text = result.usage.textInputTokens ?? result.usage.inputTokens - image;
    return {
      cost:
        (text * pricing.tokens.textInput +
          image * pricing.tokens.imageInput +
          result.usage.outputTokens * pricing.tokens.output) /
          1_000_000 +
        fees,
      costSource: "pricing",
    };
  }
  // A quality without its own price, or one the provider picked itself, is an estimate.
  const exact = request.quality ? pricing?.perImage?.[request.quality] : undefined;
  const price = exact ?? pricing?.perImage?.default;
  if (price === undefined || result.images === 0) return { cost: null, costSource: null };
  return {
    cost: price * result.images + fees,
    costSource:
      exact !== undefined || (request.quality === null && request.qualities.length === 0)
        ? "pricing"
        : "estimate",
  };
};

/**
 * `generate_image` for one attempt. The handler returns a byte-free result and
 * stages the images by provider call id; the engine stores them under the
 * fence when it reads the terminal result, like a custom tool's files.
 */
export function prepareImageTool(input: {
  readonly model: ImageModelDescriptor;
  readonly resolveFile: ((reference: string) => Effect.Effect<ToolFile, string>) | undefined;
  readonly budget: ImageBudget;
  readonly record: (operation: ImageOperation) => Effect.Effect<void>;
  /** The row the engine made for a provider call, which the handler cannot mint itself. */
  readonly rowIdFor: (providerCallId: string) => Effect.Effect<string | undefined>;
  /** Shows an in-progress image of a call, by its row; nothing about it is kept. */
  readonly preview?: (rowId: string, image: ImagePreview) => Effect.Effect<void>;
}): { readonly group: ToolGroup; readonly take: (callId: string) => StagedImages | undefined } {
  const staged = new Map<string, StagedImages>();
  const family = imageFamily(input.model.family);
  const caps = effectiveImageCapabilities(input.model.family, input.model.capabilities);
  const editLimit = caps.edit?.maxReferences ?? 0;

  const handler = (args: Record<string, unknown>, context: { readonly toolCallId: string }) =>
    Effect.gen(function* () {
      const prompt = typeof args["prompt"] === "string" ? args["prompt"].trim() : "";
      if (!prompt) return { ok: false, error: "Describe the image in `prompt`." };
      const rawReferences = args["references"];
      if (
        rawReferences !== undefined &&
        (!Array.isArray(rawReferences) || rawReferences.some((item) => typeof item !== "string"))
      )
        return { ok: false, error: "`references` is a list of file references." };
      const named = (rawReferences ?? []) as ReadonlyArray<string>;
      const references: ImageReference[] = [];
      let referenceBytes = 0;
      // Only as many as the model takes are read; one more than none, so a
      // model without editing still refuses the call rather than ignore them.
      for (const reference of named.slice(0, Math.max(1, editLimit))) {
        if (!input.resolveFile) return { ok: false, error: "Files cannot be read in this chat." };
        const file = yield* input.resolveFile(reference).pipe(Effect.result);
        if (file._tag === "Failure") return { ok: false, error: file.failure };
        if (!(family.referenceTypes as ReadonlyArray<string>).includes(file.success.mediaType))
          return {
            ok: false,
            error: `${file.success.name} cannot be used as a reference: ${input.model.name} takes ${family.referenceTypes
              .map((type) => type.replace("image/", "").toUpperCase())
              .join(", ")} images.`,
          };
        referenceBytes += file.success.bytes.length;
        if (referenceBytes > MAX_REFERENCE_BYTES)
          return { ok: false, error: "The reference images are too large together." };
        references.push({
          name: file.success.name,
          mediaType: file.success.mediaType,
          bytes: file.success.bytes,
        });
      }
      const count = typeof args["count"] === "number" ? Math.floor(args["count"]) : undefined;
      const aspectRatio = oneOf(ASPECT_RATIOS, args["aspect_ratio"]);
      const quality = oneOf(IMAGE_QUALITIES, args["quality"]);
      const fitted = normalizeImageRequest(input.model.family, input.model.capabilities, {
        prompt,
        references,
        referencesNamed: named.length,
        ...(aspectRatio ? { aspectRatio } : {}),
        ...(quality ? { quality } : {}),
        ...(args["background"] === "transparent" || args["background"] === "opaque"
          ? { background: args["background"] }
          : {}),
        ...(count !== undefined ? { count } : {}),
      });
      if (fitted.refusal) return { ok: false, model: input.model.name, error: fitted.refusal };
      const adjustments = [...fitted.adjustments];
      const granted = input.budget.reserve(fitted.request.count);
      if (granted === 0)
        return {
          ok: false,
          model: input.model.name,
          error: "This answer already holds as many images as it may. Continue in a new message.",
        };
      if (granted < fitted.request.count)
        adjustments.push(
          `Made ${granted} of ${fitted.request.count}: the answer is near its image limit.`,
        );
      const request = { ...fitted.request, count: granted };
      // Waited on before the provider is asked, never in the ledger's finalizer.
      const rowId = (yield* input.rowIdFor(context.toolCallId)) ?? null;

      let outcome: ImageResult | null = null;
      const preview = rowId ? input.preview : undefined;
      const result = yield* generateImages(input.model.connection, {
        model: input.model.modelKey,
        family: input.model.family,
        request,
        ...(preview
          ? {
              onPartial: (partial: ImagePreview) =>
                preview(rowId!, partial).pipe(Effect.catchCause(() => Effect.void)),
            }
          : {}),
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.tap((value) =>
          Effect.sync(() => {
            outcome = value;
          }),
        ),
        // Recorded once whatever happens, delivery or not: the provider has
        // billed by now. Interrupted before it answered, the usage is unknown.
        Effect.onExit((exit) => {
          const done: ImageResult | null = outcome;
          const images = done?.kind === "images" ? done.images.length : 0;
          const priced = done
            ? imageCost(
                input.model.pricing,
                // The family's, not the admin's: with every quality hidden the
                // provider still picks one.
                {
                  quality: request.quality,
                  qualities: family.limits.qualities,
                  references: request.references.length,
                },
                { ...done, images },
              )
            : { cost: null, costSource: null };
          return input.record({
            toolCallId: rowId,
            status: Exit.isSuccess(exit)
              ? images > 0
                ? "complete"
                : "error"
              : Exit.hasInterrupts(exit)
                ? "aborted"
                : "error",
            images,
            usage: {
              inputTokens: done?.usage?.inputTokens ?? 0,
              outputTokens: done?.usage?.outputTokens ?? 0,
              // Complete means the whole cost is known: reported, or an exact
              // price per image, which needs no usage at all (Bedrock).
              complete:
                done !== null &&
                !done.incomplete &&
                (done.usage !== undefined ||
                  done.cost !== undefined ||
                  priced.costSource === "pricing"),
            },
            ...priced,
          });
        }),
        Effect.result,
      );
      if (result._tag === "Failure") {
        input.budget.release(granted);
        return { ok: false, model: input.model.name, error: describeFailure(result.failure) };
      }
      if (result.success.kind === "refused") {
        input.budget.release(granted);
        return { ok: false, model: input.model.name, refusal: result.success.message };
      }
      if (result.success.kind === "unusable") {
        input.budget.release(granted);
        return {
          ok: false,
          model: input.model.name,
          error: result.success.message.slice(0, 300) || "The image model sent nothing usable.",
        };
      }
      // A batch that came back short says why, first, so the caption keeps it.
      if (result.success.shortfall) adjustments.unshift(result.success.shortfall);
      const images = result.success.images.slice(0, granted);
      input.budget.release(granted - images.length);
      staged.set(context.toolCallId, {
        images,
        stem: imageFileStem(args["name"], prompt),
        settle: (delivered) => input.budget.release(images.length - delivered),
      });
      return {
        ok: true,
        model: input.model.name,
        images: images.length,
        ...(request.quality ? { quality: request.quality } : {}),
        ...(adjustments.length ? { adjustments } : {}),
        ...(result.success.revisedPrompt ? { revisedPrompt: result.success.revisedPrompt } : {}),
      };
    });

  return {
    group: { toolkit: Toolkit.make(tool), handlers: { [IMAGE_TOOL]: handler } },
    take: (callId) => {
      const value = staged.get(callId);
      staged.delete(callId);
      return value;
    },
  };
}

const describeFailure = (failure: unknown): string => {
  const message =
    failure && typeof failure === "object" && "message" in failure
      ? String((failure as { message: unknown }).message)
      : String(failure);
  return message.slice(0, 300) || "The image model failed.";
};

/**
 * What a call will draw, fitted to the model as the handler fits it, so the
 * placeholder never jumps when the image lands. An edit without a ratio follows
 * its reference, which only the handler reads: square until then.
 */
export const imageCallShape = (
  model: ImageModelDescriptor,
  args: Record<string, unknown>,
): ImageCallShape => {
  const aspectRatio = oneOf(ASPECT_RATIOS, args["aspect_ratio"]);
  const { request } = normalizeImageRequest(model.family, model.capabilities, {
    prompt: "frame",
    references: [],
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(typeof args["count"] === "number" ? { count: Math.floor(args["count"]) } : {}),
  });
  return {
    model: model.name,
    editing: Array.isArray(args["references"]) && args["references"].length > 0,
    aspectRatio: request.aspectRatio,
    requested: request.count,
  };
};

/**
 * The trailing note that tells the model which image model this answer draws
 * with. It sits after history, so a different model never uncaches the prefix.
 */
export const imageModelNote = (model: ImageModelDescriptor, nativeImages: boolean) => {
  const caps = model.capabilities;
  const can = [
    caps.generate ? "creates images from a prompt" : "does not create images from a prompt alone",
    caps.edit
      ? `edits with up to ${caps.edit.maxReferences} reference image${caps.edit.maxReferences === 1 ? "" : "s"}`
      : "cannot edit or take reference images",
    `aspect ratios ${caps.aspectRatios.join(", ")}`,
    caps.qualities.length ? `quality ${caps.qualities.join("/")}` : null,
    caps.transparency ? "transparent backgrounds" : "no transparent backgrounds",
    `up to ${caps.maxCount} per call`,
  ].filter(Boolean);
  return [
    `generate_image draws with ${JSON.stringify(model.name)}${model.description ? ` (${model.description})` : ""}. It ${can.join("; ")}.`,
    "If a request needs something this model cannot do, say so and suggest picking another image model under Image model in the composer’s + menu before calling.",
    nativeImages
      ? "You can also output images yourself; use generate_image when the person wants the chosen image model or its strengths."
      : null,
  ]
    .filter(Boolean)
    .join(" ");
};
