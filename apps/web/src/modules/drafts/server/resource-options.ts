import { Effect, Schema } from "effect";
import type { AgentRepo } from "~/modules/agents/server/repo.ts";
import type { KnowledgeRepo } from "~/modules/knowledge/server/repo.ts";
import type { ProviderRepo } from "~/modules/providers/server/repo.ts";
import type { SkillRepo } from "~/modules/skills/server/repo.ts";

/** What a draft may name by id, and so what its options tool lists. */
export const OptionKind = Schema.Literals(["agents", "models", "skills", "collections"]);
export type OptionKind = typeof OptionKind.Type;

/** Singular and near-miss spellings a model writes for the same category. */
export const OPTION_KIND_ALIASES: Record<string, OptionKind> = {
  agent: "agents",
  agents: "agents",
  model: "models",
  models: "models",
  skill: "skills",
  skills: "skills",
  collection: "collections",
  collections: "collections",
  knowledge: "collections",
  "knowledge collections": "collections",
  knowledge_collections: "collections",
  documents: "collections",
};

export const ResourceOption = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
});
export type ResourceOption = typeof ResourceOption.Type;

export const OptionsParams = Schema.Struct({
  kind: OptionKind,
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
});

export type ResourceOptionServices = {
  agents: AgentRepo["Service"];
  providers: ProviderRepo["Service"];
  skills: SkillRepo["Service"];
  knowledge: KnowledgeRepo["Service"];
};

/**
 * The resources a person may put in an agent or schedule draft. Agents are
 * only their own: a draft edits one, and a schedule runs only its owner's.
 */
export const makeResourceOptions = (services: ResourceOptionServices, userId: string) => {
  const list = Effect.fn(function* (kind: OptionKind) {
    const rows =
      kind === "agents"
        ? (yield* services.agents.list(userId))
            .filter((agent) => agent.canEdit)
            .map(({ id, name, description }) => ({ id, name, description }))
        : kind === "models"
          ? (yield* services.providers.listChatModelsFor(userId)).map((model) => ({
              id: model.id,
              name: model.displayName,
              description: "",
            }))
          : kind === "skills"
            ? (yield* services.skills.list(userId)).map(({ id, name, description }) => ({
                id,
                name,
                description,
              }))
            : (yield* services.knowledge.listCollections(userId)).map(
                ({ id, name, description }) => ({ id, name, description }),
              );
    return rows.map((row) => ({ ...row, description: row.description.slice(0, 500) }));
  });
  /** Up to 20 matches after `cursor`, in id order, with the cursor for the rest. */
  const page = Effect.fn(function* (kind: OptionKind, query = "", cursor = "") {
    const rows = yield* list(kind);
    const matches = rows
      .filter(
        (row) =>
          !query ||
          `${row.name} ${row.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
      )
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .filter((row) => !cursor || row.id > cursor);
    const shown = matches.slice(0, 20);
    return {
      options: shown,
      ...(matches.length > shown.length ? { nextCursor: shown.at(-1)!.id } : {}),
    };
  });
  return { list, page };
};

/** A draft session's argument hook: a near-miss option kind read as the real one. */
export const normalizeOptionKind = (key: string, value: unknown) =>
  key === "kind" && typeof value === "string"
    ? (OPTION_KIND_ALIASES[value.trim().toLowerCase()] ?? value)
    : value;
