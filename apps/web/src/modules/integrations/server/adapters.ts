import { jiraAdapter } from "../jira/server/adapter.ts";
import { outlookAdapter } from "../outlook/server/adapter.ts";
import { outlineAdapter } from "../outline/server/adapter.ts";
import type { IntegrationAdapter } from "./adapter.ts";

/** Server halves of `INTEGRATIONS`, keyed by the same id. */
export const ADAPTERS: ReadonlyArray<IntegrationAdapter> = [
  outlineAdapter,
  outlookAdapter,
  jiraAdapter,
];

export const findAdapter = (id: string) => ADAPTERS.find((adapter) => adapter.id === id) ?? null;
