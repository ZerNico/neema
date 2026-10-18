import { Effect, Schema } from "effect";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { ProjectService } from "~/modules/projects/server/service.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { defineTool, result } from "./define.ts";

const none = Schema.Struct({});
const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

/** What a send can name: agents, models and projects, each with the id it takes. */
export const listAgents = defineTool({
  name: "list_agents",
  title: "List agents",
  description:
    "Agents this person can start a chat with: saved instructions, model, knowledge and skills. Pass an id as `agentId` to send_message to start a chat with it.",
  scope: "chats:read",
  input: none,
  annotations: readOnly,
  run: (_args, { principal }) =>
    Effect.gen(function* () {
      const agents = yield* AgentRepo.use((repo) => repo.list(principal.userId));
      const rows = agents.map(({ id, name, description }) => ({ id, name, description }));
      const text = rows.length
        ? rows
            .map((a) => `- ${a.name} (${a.id})${a.description ? `: ${a.description}` : ""}`)
            .join("\n")
        : "No agents available.";
      return result(text, { agents: rows });
    }),
});

export const listModels = defineTool({
  name: "list_models",
  title: "List models",
  description:
    "Chat models this person may use. Pass an id as `modelId` to send_message; without one a chat uses its last model or the default.",
  scope: "chats:read",
  input: none,
  annotations: readOnly,
  run: (_args, { principal }) =>
    Effect.gen(function* () {
      const models = yield* ProviderRepo.use((repo) => repo.listChatModelsFor(principal.userId));
      const rows = models.map((m) => ({
        id: m.id,
        name: m.displayName,
        provider: m.providerName,
        isDefault: m.isDefault,
      }));
      const text = rows.length
        ? rows
            .map((m) => `- ${m.name} (${m.id}, ${m.provider})${m.isDefault ? " [default]" : ""}`)
            .join("\n")
        : "No models available.";
      return result(text, { models: rows });
    }),
});

export const listProjects = defineTool({
  name: "list_projects",
  title: "List projects",
  description:
    "Projects this person belongs to, with their role. Pass an id as `projectId` to send_message to start a chat inside one.",
  scope: "chats:read",
  input: none,
  annotations: readOnly,
  run: (_args, { principal }) =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.use((service) => service.list(principal.userId));
      const rows = projects.map(({ id, name, description, role }) => ({
        id,
        name,
        description,
        role,
      }));
      const text = rows.length
        ? rows
            .map(
              (p) => `- ${p.name} (${p.id}, ${p.role})${p.description ? `: ${p.description}` : ""}`,
            )
            .join("\n")
        : "No projects.";
      return result(text, { projects: rows });
    }),
});
