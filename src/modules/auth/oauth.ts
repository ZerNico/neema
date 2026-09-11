import { Schema } from "effect";

/**
 * A provider Better Auth ships an implementation for. The id is Better Auth's
 * own key, so it doubles as the callback path segment and cannot be chosen.
 * `field` is the one non-secret setting that provider needs beyond the client
 * credentials; everything else uses the provider's defaults.
 */
export interface OAuthBuiltin {
  readonly id: string;
  readonly label: string;
  readonly field?: {
    readonly key: "tenantId" | "issuer";
    readonly label: string;
    readonly description: string;
  };
}

// Adding one here also needs a case in `socialProvidersFrom`
// (server/config.ts), which is where Better Auth's per-provider option types
// are satisfied. An entry with no case there is never registered.
export const OAUTH_BUILTINS: readonly OAuthBuiltin[] = [
  { id: "google", label: "Google" },
  { id: "github", label: "GitHub" },
  {
    id: "microsoft",
    label: "Microsoft",
    field: {
      key: "tenantId",
      label: "Tenant ID",
      description: "Leave empty to accept any Microsoft account.",
    },
  },
  {
    id: "gitlab",
    label: "GitLab",
    field: {
      key: "issuer",
      label: "GitLab URL",
      description: "Leave empty for gitlab.com.",
    },
  },
  { id: "discord", label: "Discord" },
  { id: "apple", label: "Apple" },
];

export const findBuiltin = (id: string) => OAUTH_BUILTINS.find((b) => b.id === id) ?? null;

// Non-secret extras for a built-in row (oauth_providers.config jsonb). Both
// keys are provider-specific; a row carries at most the one its provider reads.
export const BuiltinOAuthConfig = Schema.Struct({
  tenantId: Schema.optionalKey(Schema.String),
  issuer: Schema.optionalKey(Schema.String),
});
export type BuiltinOAuthConfig = typeof BuiltinOAuthConfig.Type;

/**
 * Non-secret extras for a generic OIDC row. Discovery is the only supported
 * way in: every OIDC provider publishes the document, and four hand-entered
 * endpoint URLs are four ways to mistype one.
 */
export const OidcOAuthConfig = Schema.Struct({
  discoveryUrl: Schema.String.check(Schema.isMinLength(1)),
  scopes: Schema.Array(Schema.String),
});
export type OidcOAuthConfig = typeof OidcOAuthConfig.Type;

export const OIDC_DEFAULT_SCOPES = ["openid", "profile", "email"] as const;

// An OIDC id is ours to choose, so it is constrained to what reads cleanly in
// a callback URL.
const OidcProviderId = Schema.String.check(
  Schema.isMinLength(2),
  Schema.isMaxLength(32),
  Schema.isPattern(/^[a-z][a-z0-9-]*$/, {
    message: "Use lowercase letters, digits and dashes.",
  }),
);

const Label = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));
const ClientId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));

export const SaveBuiltinProviderInput = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  enabled: Schema.Boolean,
  trusted: Schema.Boolean,
  clientId: ClientId,
  // empty means "keep the stored secret"
  secret: Schema.optionalKey(Schema.String),
  tenantId: Schema.optionalKey(Schema.String),
  issuer: Schema.optionalKey(Schema.String),
});
export type SaveBuiltinProviderInput = typeof SaveBuiltinProviderInput.Type;

export const SaveOidcProviderInput = Schema.Struct({
  id: OidcProviderId,
  label: Label,
  enabled: Schema.Boolean,
  trusted: Schema.Boolean,
  clientId: ClientId,
  secret: Schema.optionalKey(Schema.String),
  discoveryUrl: Schema.String.check(Schema.isMinLength(1)),
  scopes: Schema.Array(Schema.String),
});
export type SaveOidcProviderInput = typeof SaveOidcProviderInput.Type;

export const SetOAuthProviderEnabledInput = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  enabled: Schema.Boolean,
});

export const OAuthProviderId = Schema.Struct({ id: Schema.String.check(Schema.isMinLength(1)) });

/** What the sign-in page needs: enough for a button, nothing about the client. */
export interface SignInProvider {
  readonly id: string;
  readonly label: string;
}
