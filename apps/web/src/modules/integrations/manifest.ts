import { Schema } from "effect";
import type { ComponentProps, ComponentType } from "react";

/**
 * How much a tool can change. Consent keys on this, never on a tool's name:
 * reads default to allowed and changes to asking. A destructive tool runs
 * unasked only when the person allowed it in Settings: never from a one-off
 * approval, never in a scheduled run.
 */
export type ToolAccess = "read" | "write" | "destructive";

/**
 * One model-callable function, defined once and read by both halves: the
 * client renders it (Settings, tool rows, approvals) and the server offers it
 * and runs its handler, which `IntegrationHandlers` keys by `name`.
 */
/** Parameters that decode without services, so a summary can decode them anywhere. */
export type ToolFields = {
  readonly [key: string]: Schema.Top & { readonly DecodingServices: never };
};

export interface IntegrationToolDefinition<
  Name extends string = string,
  Fields extends ToolFields = ToolFields,
> {
  /** The handler's key; the model sees `int_<integration>__<name>`. */
  readonly name: Name;
  /** What the tool does, for Settings: "Search documents". */
  readonly title: string;
  /** What a call did, for the transcript: "Searched Outline". */
  readonly label: string;
  /** What the model reads when choosing it. */
  readonly description: string;
  readonly access: ToolAccess;
  /**
   * Every field `Schema.optionalKey`: a key the model omits must reach the
   * handler, which explains it, instead of failing the whole generation.
   */
  readonly parameters: Schema.Struct<Fields>;
  /** One line for the tool row and approval card, from the model's arguments. */
  summarize(args: Schema.Struct.Type<Fields>): string | null;
}

export const defineIntegrationTool = <const Name extends string, Fields extends ToolFields>(
  tool: IntegrationToolDefinition<Name, Fields>,
) => tool;

/**
 * The row summary from raw call arguments. They are decoded first, as the
 * handler gets them; arguments that do not decode get no summary, since the
 * handler will refuse them anyway.
 */
export const summarizeCall = (tool: IntegrationToolDefinition, args: unknown) => {
  const decoded = Schema.decodeUnknownOption(tool.parameters)(args);
  return decoded._tag === "Some" ? tool.summarize(decoded.value) : null;
};

/**
 * A way some calls reach people beyond the account, such as sending mail.
 * Such a call counts as destructive whatever its tool declares, so it is
 * asked about in a chat. A schedule may grant it for named targets only, and
 * runs at most `cap` such calls per run.
 */
export interface IntegrationAllowance {
  readonly id: string;
  /** The schedule editor's switch: "Send mail". */
  readonly label: string;
  /** What the switch lets runs do, for the schedule editor. */
  readonly description: string;
  /** The tools whose calls may reach targets under it. */
  readonly tools: ReadonlyArray<string>;
  /** Only email addresses exist so far; each kind brings its own exact parser. */
  readonly targets: "email";
  readonly cap: number;
}

/**
 * One input of a form the manifest declares: the admin's setup, or what a
 * person pastes to connect without OAuth. The kind picks the control and,
 * for a person's credential, the check made before the service is asked.
 */
export interface IntegrationField {
  readonly key: string;
  readonly label: string;
  /** `secret` is never shown again once saved. */
  readonly kind: "url" | "text" | "email" | "secret";
  readonly placeholder?: string;
  readonly description?: string;
  readonly required: boolean;
}

/**
 * What a connection can be limited to. The adapter lists the choices and
 * enforces them: it narrows what reads return, and every change names the
 * items it touches so the tool layer can refuse one outside the limit.
 */
export interface IntegrationScope {
  /** The settings section: "Projects". */
  readonly label: string;
  /** One of them, in a sentence: "project". */
  readonly noun: string;
}

/**
 * How an admin registers the OAuth app, shown as numbered steps beside the
 * redirect URI. `values` are things to copy exactly, such as scopes.
 */
export interface OAuthSetup {
  /** Where the app is registered; the first step links to it. */
  readonly console: {
    readonly label: string;
    readonly url: (config: Readonly<Record<string, string>>) => string | null;
  };
  readonly steps: ReadonlyArray<{ readonly text: string; readonly values?: ReadonlyArray<string> }>;
}

/**
 * Everything the client needs to render an integration anywhere: settings,
 * admin, the composer, tool rows, approvals and knowledge sources. Behaviour
 * lives in the server adapter with the same id.
 */
export interface IntegrationManifest {
  /** The type: what instances name as their `kind`, and the adapter with the same key. */
  readonly kind: string;
  readonly name: string;
  readonly description: string;
  readonly logo: ComponentType<ComponentProps<"svg">>;
  readonly adminFields: ReadonlyArray<IntegrationField>;
  /** Present when the service can act as an OAuth provider for us. */
  readonly oauth: { readonly setup: OAuthSetup } | null;
  /**
   * Present when a person can connect by pasting an API key instead of
   * OAuth. The fields are everything the service needs with it (some want
   * the account's email beside the key); the adapter decides how to send them.
   */
  readonly apiKey: {
    readonly fields: ReadonlyArray<IntegrationField>;
    /** Where in the service a person creates one, from the admin config. */
    readonly helpUrl: (config: Readonly<Record<string, string>>) => string | null;
  } | null;
  readonly tools: ReadonlyArray<IntegrationToolDefinition>;
  readonly allowances: ReadonlyArray<IntegrationAllowance>;
  /**
   * Present when a person can limit their connection to some of the
   * service's containers (Jira projects). Every call then stays inside them,
   * in chats, agents and schedules alike.
   */
  readonly scope: IntegrationScope | null;
  /** Whether a knowledge collection can mirror part of it. */
  readonly knowledgeSource: boolean;
}

const TOOL_PREFIX = "int_";

/**
 * An integration's id: chosen once, carried by tool names (`int_<id>__…`, 64
 * characters at most) and the OAuth callback path, so short and plain.
 */
export const INTEGRATION_ID = /^[a-z][a-z0-9-]{1,23}$/;

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
