import type { ComponentProps, ComponentType } from "react";

/**
 * How much a tool can change. Consent keys on this, never on a tool's name:
 * reads default to allowed and changes to asking. A destructive tool runs
 * unasked only when the person allowed it in Settings: never from a one-off
 * approval, never in a scheduled run.
 */
export type ToolAccess = "read" | "write" | "destructive";

export interface IntegrationToolManifest {
  /** The adapter's key; the model sees `int_<integration>__<name>`. */
  readonly name: string;
  /** What the tool does, for Settings: "Search documents". */
  readonly title: string;
  /** What a call did, for the transcript: "Searched Outline". */
  readonly label: string;
  readonly access: ToolAccess;
  /** One line for the tool row and approval card, from the model's arguments. */
  readonly summarize: (args: Readonly<Record<string, unknown>>) => string | null;
}

export interface IntegrationAdminField {
  readonly key: string;
  readonly label: string;
  readonly kind: "url" | "text";
  readonly placeholder?: string;
  readonly description?: string;
  readonly required: boolean;
}

/**
 * Everything the client needs to render an integration anywhere: settings,
 * admin, the composer, tool rows, approvals and knowledge sources. Behaviour
 * lives in the server adapter with the same id.
 */
export interface IntegrationManifest {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly logo: ComponentType<ComponentProps<"svg">>;
  readonly adminFields: ReadonlyArray<IntegrationAdminField>;
  /** Present when the service can act as an OAuth provider for us. */
  readonly oauth: { readonly setup: string } | null;
  /** Present when a personal API key can stand in for OAuth. */
  readonly apiKey: {
    readonly label: string;
    readonly placeholder?: string;
    /** Where in the service a person creates one, from the admin config. */
    readonly helpUrl: (config: Readonly<Record<string, string>>) => string | null;
  } | null;
  readonly tools: ReadonlyArray<IntegrationToolManifest>;
  /** Whether a knowledge collection can mirror part of it. */
  readonly knowledgeSource: boolean;
}

const TOOL_PREFIX = "int_";

/**
 * Both halves are slugs, so the name stays within the common 64-character
 * provider limit (checked by the catalog test). The prefix is the durable
 * family marker for persisted rows; inside a generation the resolved offer
 * decides what counts as an integration call, as for custom tools.
 */
export const integrationToolName = (integrationId: string, tool: string) =>
  `${TOOL_PREFIX}${integrationId}__${tool}`;

export const parseIntegrationToolName = (name: string) => {
  if (!name.startsWith(TOOL_PREFIX)) return null;
  const rest = name.slice(TOOL_PREFIX.length);
  const split = rest.indexOf("__");
  if (split <= 0) return null;
  return { integrationId: rest.slice(0, split), tool: rest.slice(split + 2) };
};
