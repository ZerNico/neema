import { jiraManifest } from "./jira/manifest.ts";
import type { IntegrationManifest } from "./manifest.ts";
import { outlookManifest } from "./outlook/manifest.ts";
import { outlineManifest } from "./outline/manifest.ts";

/**
 * Every integration type the code ships; the server adapters mirror this
 * list. An admin sets up instances of these, each with its own id.
 */
export const INTEGRATION_TYPES: ReadonlyArray<IntegrationManifest> = [
  outlineManifest,
  outlookManifest,
  jiraManifest,
];

/** The type by its `kind`, never by an integration's id. */
export const findIntegrationType = (kind: string) =>
  INTEGRATION_TYPES.find((type) => type.kind === kind) ?? null;
