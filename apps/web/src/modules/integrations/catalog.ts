import { jiraManifest } from "./jira/manifest.ts";
import type { IntegrationManifest } from "./manifest.ts";
import { outlookManifest } from "./outlook/manifest.ts";
import { outlineManifest } from "./outline/manifest.ts";

/** Every integration the code ships; the server adapters mirror this list. */
export const INTEGRATIONS: ReadonlyArray<IntegrationManifest> = [
  outlineManifest,
  outlookManifest,
  jiraManifest,
];

export const findIntegration = (id: string) =>
  INTEGRATIONS.find((integration) => integration.id === id) ?? null;
