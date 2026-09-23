import type { IntegrationManifest } from "./manifest.ts";
import { outlineManifest } from "./outline/manifest.ts";

/** Every integration the code ships; the server adapters mirror this list. */
export const INTEGRATIONS: ReadonlyArray<IntegrationManifest> = [outlineManifest];

export const findIntegration = (id: string) =>
  INTEGRATIONS.find((integration) => integration.id === id) ?? null;
