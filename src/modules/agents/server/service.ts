import { Context, Effect, Layer, Schema } from "effect";
import { KnowledgeRepo } from "~/modules/knowledge/server/repo.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { AgentNotAvailable, AgentRejected } from "../errors.ts";
import {
  AgentSettings,
  type AgentDetail,
  type AgentSelectionDetail,
  type AgentSummary,
  type UpdateAgentInput,
} from "../schema.ts";
import { AgentRepo, summarizeAgent } from "./repo.ts";

export class AgentService extends Context.Service<
  AgentService,
  {
    list(userId: string): Effect.Effect<ReadonlyArray<AgentSummary>>;
    detail(userId: string, agentId: string): Effect.Effect<AgentDetail, AgentNotAvailable>;
    selection(
      userId: string,
      agentId: string,
    ): Effect.Effect<AgentSelectionDetail, AgentNotAvailable>;
    create(userId: string, input: AgentSettings): Effect.Effect<string, AgentRejected>;
    update(
      userId: string,
      input: UpdateAgentInput,
    ): Effect.Effect<void, AgentNotAvailable | AgentRejected>;
    remove(userId: string, agentId: string): Effect.Effect<void, AgentNotAvailable>;
  }
>()("chat/agents/AgentService") {
  static readonly layer = Layer.effect(
    AgentService,
    Effect.gen(function* () {
      const repo = yield* AgentRepo;
      const knowledge = yield* KnowledgeRepo;
      const providers = yield* ProviderRepo;
      const bus = yield* SyncBus;
      const changed = () =>
        bus
          .publishGlobal({ type: "resources.changed" })
          .pipe(Effect.catchCause(() => Effect.logWarning("agent resource invalidation failed")));
      const available = Effect.fn(function* (userId: string, agentId: string, ownerOnly = false) {
        const agent = yield* repo.get(userId, agentId);
        if (!agent || (ownerOnly && agent.row.userId !== userId))
          return yield* new AgentNotAvailable({ agentId });
        return agent;
      });
      const modelFor = Effect.fn(function* (userId: string, modelId: string) {
        const model = yield* providers.getModel(modelId);
        if (
          !model ||
          !model.enabled ||
          model.type !== "chat" ||
          !(yield* providers.isModelAccessible(userId, modelId))
        )
          return null;
        return { id: model.id, name: model.displayName, available: true };
      });
      const validate = Effect.fn(function* (userId: string, input: AgentSettings) {
        const settings = yield* Schema.decodeUnknownEffect(AgentSettings)(input).pipe(
          Effect.mapError(() => new AgentRejected({ reason: "invalid agent settings" })),
        );
        if (!settings.name.trim() || settings.starters.some((starter) => !starter.trim()))
          return yield* new AgentRejected({
            reason: "name and conversation starters must not be blank",
          });
        if (settings.modelId && !(yield* modelFor(userId, settings.modelId)))
          return yield* new AgentRejected({ reason: "selected model is unavailable" });
        return {
          ...settings,
          name: settings.name.trim(),
          description: settings.description.trim(),
          starters: settings.starters.map((starter) => starter.trim()),
          collectionIds: [...new Set(settings.collectionIds)],
        };
      });
      const load = Effect.fn("AgentService.load")(function* (
        userId: string,
        agentId: string,
        ownerOnly: boolean,
      ) {
        const { row, ownerName, collectionIds } = yield* available(userId, agentId, ownerOnly);
        const model = row.modelId
          ? ((yield* modelFor(userId, row.modelId)) ?? {
              id: row.modelId,
              name: null,
              available: false,
            })
          : null;
        const collections = yield* Effect.forEach(
          collectionIds,
          (id) =>
            knowledge.getCollection(userId, id).pipe(
              Effect.map((collection) => ({
                id,
                name: collection?.name ?? null,
                available: collection !== null,
              })),
            ),
          { concurrency: 3 },
        );
        yield* available(userId, agentId, ownerOnly);
        return {
          row,
          selection: {
            ...summarizeAgent(row, ownerName, userId),
            modelId: row.modelId,
            searchEnabled: row.searchEnabled,
            planEnabled: row.planEnabled,
            starters: row.starters,
            model,
            collections,
          } satisfies AgentSelectionDetail,
        };
      });
      return AgentService.of({
        list: repo.list,
        detail: (userId, agentId) =>
          load(userId, agentId, true).pipe(
            Effect.map(({ row, selection }) => ({ ...selection, instructions: row.instructions })),
          ),
        selection: (userId, agentId) =>
          load(userId, agentId, false).pipe(Effect.map(({ selection }) => selection)),
        create: Effect.fn("AgentService.create")(function* (userId, input) {
          const id = yield* repo.create(userId, yield* validate(userId, input));
          yield* changed();
          return id;
        }),
        update: Effect.fn("AgentService.update")(function* (userId, input) {
          yield* available(userId, input.agentId, true);
          if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1)
            return yield* new AgentRejected({ reason: "invalid agent revision" });
          yield* repo.update(userId, {
            ...(yield* validate(userId, input)),
            agentId: input.agentId,
            expectedRevision: input.expectedRevision,
          });
          yield* changed();
        }),
        remove: Effect.fn("AgentService.remove")(function* (userId, agentId) {
          if (!(yield* repo.remove(userId, agentId)))
            return yield* new AgentNotAvailable({ agentId });
          yield* changed();
        }),
      });
    }),
  );
}
