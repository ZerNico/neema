import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { agents, conversations } from "~/db/schema/index.ts";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import { ProviderRepo, type ImageModelRow } from "~/modules/providers/server/repo.ts";
import { ToolsRepo } from "~/modules/tools/server/repo.ts";
import { IMAGE_GENERATION_TOOL, imageGenerationEnabled } from "../settings.ts";

/** The image models this person may use now, in the admin's order; none while switched off. */
export const availableImageModels = Effect.fn("images.availableImageModels")(function* (
  userId: string,
) {
  const tools = yield* Effect.serviceOption(ToolsRepo);
  const enabled = imageGenerationEnabled(
    Option.isSome(tools) ? yield* tools.value.getTool(IMAGE_GENERATION_TOOL) : null,
  );
  if (!enabled) return [] as ReadonlyArray<ImageModelRow>;
  return yield* (yield* ProviderRepo).listImageModelsFor(userId);
});

/**
 * One attempt's image model: what this submission chose, else the chat's
 * lock, else the agent's preference, else the admin's first. Whatever is
 * chosen becomes the lock in the attempt's own transaction, so a fallback
 * moves it and a later attempt starts from there. A resume keeps the model
 * its earlier rounds drew with, or offers no tool, and leaves the lock alone.
 */
export const resolveImageModel = Effect.fn("images.resolveImageModel")(function* (
  tx: DbTx,
  input: {
    readonly userId: string;
    readonly conversationId: string | undefined;
    readonly lockId: string | null | undefined;
    readonly explicitId: string | null | undefined;
    readonly agentId: string | null | undefined;
    /** Set on resume: the answer's own model, or null when it had none. */
    readonly resumedId?: string | null | undefined;
  },
) {
  const available = yield* availableImageModels(input.userId);
  if (available.length === 0) return null;
  const usable = (id: string | null | undefined) =>
    id ? available.find((model) => model.id === id) : undefined;
  if (input.resumedId !== undefined) {
    const kept = usable(input.resumedId);
    return kept ? { id: kept.id, name: kept.displayName } : null;
  }
  const agentChoice = input.agentId
    ? (yield* tx
        .select({ imageModelId: agents.imageModelId })
        .from(agents)
        .where(eq(agents.id, input.agentId))
        .pipe(Effect.orDie))[0]?.imageModelId
    : undefined;
  const chosen =
    usable(input.explicitId) ?? usable(input.lockId) ?? usable(agentChoice) ?? available[0]!;
  if (input.conversationId && input.lockId !== chosen.id)
    yield* tx
      .update(conversations)
      .set({ imageModelId: chosen.id })
      .where(eq(conversations.id, input.conversationId))
      .pipe(Effect.orDie);
  return { id: chosen.id, name: chosen.displayName };
});
