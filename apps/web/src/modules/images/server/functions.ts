import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import {
  IMAGE_FAMILIES,
  generateImages,
  imageFamiliesFor,
  imageFamily,
  normalizeImageRequest,
} from "@chat/model-client";
import { requireAdmin, requireSession } from "~/modules/auth/server/middleware.ts";
import { connectionOf } from "~/modules/providers/server/gateway.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { ToolsRepo } from "~/modules/tools/server/repo.ts";
import { runtime } from "~/server/runtime.ts";
import { IMAGE_GENERATION_TOOL } from "../settings.ts";
import { availableImageModels } from "./resolve.ts";

const standard = Schema.toStandardSchemaV1;

/** The image models the composer's picker offers this person; none while switched off. */
export const listImageModels = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runtime.runPromise(
      availableImageModels(context.session.user.id).pipe(Effect.map((models) => [...models])),
    ),
  );

export const getImageGenerationTool = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() => runtime.runPromise(ToolsRepo.use((repo) => repo.getTool(IMAGE_GENERATION_TOOL))));

export const updateImageGenerationTool = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(Schema.Struct({ enabled: Schema.Boolean })))
  .handler(({ data }) =>
    runtime.runPromise(
      ToolsRepo.use((repo) => repo.updateTool(IMAGE_GENERATION_TOOL, { enabled: data.enabled })),
    ),
  );

/**
 * One small image before an image model is saved, so a wrong id, family or
 * key shows up in the dialog. It costs one image, which the button says.
 */
export const testImageModel = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(
    standard(
      Schema.Struct({
        providerId: Schema.String,
        modelKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
        imageFamily: Schema.Literals(IMAGE_FAMILIES),
      }),
    ),
  )
  .handler(({ data }) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const provider = yield* (yield* ProviderRepo).getProviderWithKey(data.providerId);
        if (!provider) return { ok: false as const, error: "Provider not found." };
        if (!imageFamiliesFor(provider.preset).some((family) => family.id === data.imageFamily))
          return { ok: false as const, error: "This provider does not host that family." };
        const connection = connectionOf(provider);
        if (!connection)
          return { ok: false as const, error: "The provider is missing its endpoint or key." };
        const family = imageFamily(data.imageFamily);
        const fitted = normalizeImageRequest(data.imageFamily, family.limits, {
          prompt: "A small red cube on a white table, soft daylight.",
          references: [],
          aspectRatio: "1:1",
          quality: "low",
          count: 1,
        });
        if (fitted.refusal) return { ok: false as const, error: fitted.refusal };
        const started = Date.now();
        const result = yield* generateImages(connection, {
          model: data.modelKey,
          family: data.imageFamily,
          request: fitted.request,
          // Asked the way a chat asks, streaming where the family does, so a
          // server that cannot answer a chat cannot pass the test either.
          onPartial: () => Effect.void,
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.result);
        if (result._tag === "Failure")
          return { ok: false as const, error: result.failure.message.slice(0, 300) };
        if (result.success.kind === "refused")
          return { ok: false as const, error: `Declined: ${result.success.message}` };
        if (result.success.kind === "unusable")
          return { ok: false as const, error: result.success.message.slice(0, 300) };
        const image = result.success.images[0]!;
        return {
          ok: true as const,
          latencyMs: Date.now() - started,
          image: `data:${image.mediaType};base64,${Buffer.from(image.data).toString("base64")}`,
        };
      }),
    ),
  );
