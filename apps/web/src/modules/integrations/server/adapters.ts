import { jiraAdapter } from "../jira/server/adapter.ts";
import { outlookAdapter } from "../outlook/server/adapter.ts";
import { outlineAdapter } from "../outline/server/adapter.ts";
import type { IntegrationAdapter } from "./adapter.ts";

/** Server halves of `INTEGRATION_TYPES`, keyed by the same kind. */
export const ADAPTERS: ReadonlyArray<IntegrationAdapter> = [
  outlineAdapter,
  outlookAdapter,
  jiraAdapter,
];

export const findAdapterType = (kind: string) =>
  ADAPTERS.find((adapter) => adapter.kind === kind) ?? null;
