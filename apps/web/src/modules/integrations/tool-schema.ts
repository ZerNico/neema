import { Schema } from "effect";
import { IntegrationSource } from "~/modules/tools/source-schema.ts";

const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const INTEGRATION_ACTIVITY_LIMITS = {
  name: 120,
  summary: 200,
  error: 300,
  link: 2_000,
} as const;

const Access = Schema.Literals(["read", "write", "destructive"]);
const Status = Schema.Literals(["complete", "error", "refused"]);

/** An approval the person gave in a connected app, named as it was then. */
export const IntegrationDecidedIn = Schema.Struct({
  decision: Schema.Literals(["allow", "deny"]),
  app: bounded(INTEGRATION_ACTIVITY_LIMITS.name),
});
export type IntegrationDecidedIn = typeof IntegrationDecidedIn.Type;

/**
 * What a row keeps: who did what, how it ended, and the sources it produced.
 * Arguments and page bodies never land here, since a create call can carry a
 * whole document; `summary` is the manifest's one line about the arguments.
 */
export const IntegrationToolActivity = Schema.Struct({
  family: Schema.Literal("integration"),
  version: Schema.Literal(1),
  /** Model-facing name (`int_…`); the stored family, not this prefix, says what the call is. */
  name: bounded(INTEGRATION_ACTIVITY_LIMITS.name),
  integrationId: bounded(32),
  /** The account that acted, as the person named it then; absent with one account or none. */
  account: Schema.optional(bounded(INTEGRATION_ACTIVITY_LIMITS.name)),
  tool: bounded(64),
  label: bounded(INTEGRATION_ACTIVITY_LIMITS.name),
  access: Access,
  summary: Schema.NullOr(bounded(INTEGRATION_ACTIVITY_LIMITS.summary)),
  status: Status,
  /** The page a write produced, when it named one. */
  link: Schema.optional(
    Schema.Struct({
      title: bounded(INTEGRATION_ACTIVITY_LIMITS.name),
      url: bounded(INTEGRATION_ACTIVITY_LIMITS.link),
    }),
  ),
  error: Schema.optional(bounded(INTEGRATION_ACTIVITY_LIMITS.error)),
  sources: Schema.optional(Schema.Array(IntegrationSource)),
  decidedIn: Schema.optional(IntegrationDecidedIn),
});
export type IntegrationToolActivity = typeof IntegrationToolActivity.Type;

const envelopeFields = {
  v: Schema.Literal(1),
  family: Schema.Literal("integration"),
  name: bounded(INTEGRATION_ACTIVITY_LIMITS.name),
  callId: Schema.String,
};

export const IntegrationToolEnvelope = Schema.Union([
  Schema.Struct({
    ...envelopeFields,
    phase: Schema.Literal("start"),
    turnIndex: Schema.Int,
    callIndex: Schema.Int,
    textOffset: Schema.optionalKey(Schema.Int),
    integrationId: bounded(32),
    /** The account the call names, when it names one. */
    account: Schema.optionalKey(bounded(INTEGRATION_ACTIVITY_LIMITS.name)),
    tool: bounded(64),
    label: bounded(INTEGRATION_ACTIVITY_LIMITS.name),
    access: Access,
    summary: Schema.NullOr(bounded(INTEGRATION_ACTIVITY_LIMITS.summary)),
  }),
  Schema.Struct({
    ...envelopeFields,
    phase: Schema.Literal("result"),
    activity: IntegrationToolActivity,
  }),
]);
export type IntegrationToolEnvelope = typeof IntegrationToolEnvelope.Type;

/** What the tool layer hands the model; the projection reads it back. */
export interface IntegrationModelResult {
  readonly ok: boolean;
  readonly refused?: boolean;
  readonly error?: string;
  readonly result?: unknown;
  /** The page a change produced, as the adapter named it. */
  readonly link?: { readonly title: string; readonly url: string };
  readonly citations?: ReadonlyArray<{ index: number; title: string; url: string }>;
}

const clamp = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

/** The only persistence and wire projection for integration rows. */
export function projectIntegrationToolResult(input: {
  name: string;
  integrationId: string;
  /** The account that acted, when the chat had several to choose from. */
  account?: string | null;
  tool: string;
  label: string;
  access: "read" | "write" | "destructive";
  summary: string | null;
  raw: unknown;
  isFailure: boolean;
  sources: ReadonlyArray<IntegrationSource>;
  decided?: IntegrationDecidedIn | null;
}): IntegrationToolActivity {
  const result = (input.raw ?? {}) as IntegrationModelResult;
  const ok = !input.isFailure && result.ok === true;
  const error = ok
    ? undefined
    : typeof result.error === "string"
      ? result.error
      : "The integration call failed.";
  const link =
    ok && result.link && /^https?:\/\//.test(result.link.url)
      ? {
          title: clamp(result.link.title || "Untitled", INTEGRATION_ACTIVITY_LIMITS.name),
          url: clamp(result.link.url, INTEGRATION_ACTIVITY_LIMITS.link),
        }
      : undefined;
  return {
    family: "integration",
    version: 1,
    name: clamp(input.name, INTEGRATION_ACTIVITY_LIMITS.name),
    integrationId: input.integrationId,
    ...(input.account ? { account: clamp(input.account, INTEGRATION_ACTIVITY_LIMITS.name) } : {}),
    tool: input.tool,
    label: clamp(input.label, INTEGRATION_ACTIVITY_LIMITS.name),
    access: input.access,
    summary: input.summary ? clamp(input.summary, INTEGRATION_ACTIVITY_LIMITS.summary) : null,
    status: ok ? "complete" : result.refused ? "refused" : "error",
    ...(link ? { link } : {}),
    ...(error ? { error: clamp(error, INTEGRATION_ACTIVITY_LIMITS.error) } : {}),
    ...(input.sources.length ? { sources: [...input.sources] } : {}),
    ...(input.decided
      ? {
          decidedIn: {
            decision: input.decided.decision,
            app: clamp(input.decided.app, INTEGRATION_ACTIVITY_LIMITS.name),
          },
        }
      : {}),
  };
}
