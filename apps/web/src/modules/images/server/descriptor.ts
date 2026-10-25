import { Effect } from "effect";
import { effectiveImageCapabilities } from "@chat/model-client";
import { connectionOf } from "~/modules/providers/server/gateway.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import type { ImageModelDescriptor } from "./image-tool.ts";

/**
 * The attempt's image model as it stands now, checked again here: a stored
 * row can name a family its provider no longer hosts, or a model the person
 * lost access to between resolution and this answer. Null offers no tool.
 */
export const loadImageModel = Effect.fn("images.loadImageModel")(function* (
  userId: string,
  modelId: string,
) {
  const providers = yield* ProviderRepo;
  const model = yield* providers.usableModel(userId, modelId, "image");
  if (!model?.imageFamily || !model.imageCapabilities) return null;
  const provider = yield* providers.getProviderWithKey(model.providerId);
  if (!provider) return null;
  const connection = connectionOf(provider);
  if (!connection) return null;
  return {
    id: model.id,
    name: model.displayName,
    description: model.description,
    modelKey: model.modelKey,
    family: model.imageFamily,
    capabilities: effectiveImageCapabilities(model.imageFamily, model.imageCapabilities),
    pricing: model.imagePricing,
    connection,
  } satisfies ImageModelDescriptor;
});
