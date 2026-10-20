import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import type { JsonValue } from "~/db/schema/providers.ts";
import { publicUrl } from "~/server/public-url.ts";
import { runtime } from "~/server/runtime.ts";
import { runServerFn } from "~/server/run-server-fn.ts";
import {
  findBuiltin,
  OAuthProviderId,
  SaveBuiltinProviderInput,
  SaveOidcProviderInput,
  SetOAuthProviderEnabledInput,
} from "../oauth.ts";
import { invalidateAuth } from "./auth.ts";
import { passwordLoginForced } from "./config.ts";
import { requireAdmin } from "./middleware.ts";
import { OAuthRepo, type UpsertOAuthProvider } from "./oauth-repo.ts";
import { SignupRepo } from "./signup-repo.ts";
import { refuse } from "~/server/refusal.ts";

const standard = Schema.toStandardSchemaV1;

const LAST_WAY_IN = "Turn on password sign-in before switching off the last provider.";

/** With passwords off, the last enabled provider is everyone's only way in. */
const isLastWayIn = (id: string) =>
  Effect.gen(function* () {
    if (passwordLoginForced()) return false;
    if ((yield* Effect.flatMap(SignupRepo, (repo) => repo.settings())).passwordLogin) return false;
    const providers = yield* Effect.flatMap(OAuthRepo, (repo) => repo.list());
    return !providers.some((p) => p.enabled && p.id !== id);
  });

const save = (input: UpsertOAuthProvider) =>
  runtime
    .runPromise(
      Effect.gen(function* () {
        const repo = yield* OAuthRepo;
        if (!input.enabled && (yield* isLastWayIn(input.id)))
          return { ok: false as const, error: LAST_WAY_IN };
        if (input.enabled && !input.secret) {
          const stored = (yield* repo.list()).find((p) => p.id === input.id);
          if (!stored?.secretConfigured) {
            return { ok: false as const, error: "Enter the client secret before enabling this." };
          }
        }
        const provider = yield* repo.upsert(input);
        return { ok: true as const, provider };
      }),
    )
    .then((result) => {
      if (result.ok) invalidateAuth();
      return result;
    });

/**
 * The callback URL rides along because every provider console asks for it and
 * getting it wrong is the usual first failure. It is null when
 * `PUBLIC_URL` is unset, which is also when Better Auth would guess it
 * from the request, so the page falls back to the browser's own origin.
 */
export const listOAuthProviders = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(async () => ({
    baseURL: publicUrl() ?? null,
    providers: await runServerFn(OAuthRepo.use((repo) => repo.list())),
  }));

export const saveBuiltinOAuthProvider = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(SaveBuiltinProviderInput))
  .handler(({ data }) => {
    const builtin = findBuiltin(data.id);
    if (!builtin) return Promise.resolve({ ok: false as const, error: "Unknown provider." });
    const config: Record<string, JsonValue> = {};
    // Only the field this provider actually reads is stored, so switching
    // catalogue entries cannot leave another provider's setting behind.
    if (builtin.field?.key === "tenantId" && data.tenantId) config.tenantId = data.tenantId;
    if (builtin.field?.key === "issuer" && data.issuer) config.issuer = data.issuer;
    return save({
      id: builtin.id,
      kind: "builtin",
      label: builtin.label,
      enabled: data.enabled,
      signup: data.signup,
      trustEmails: data.trustEmails,
      exclusive: data.exclusive,
      clientId: data.clientId,
      ...(data.secret ? { secret: data.secret } : {}),
      config,
    });
  });

export const saveOidcOAuthProvider = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(SaveOidcProviderInput))
  .handler(({ data }) => {
    if (findBuiltin(data.id)) {
      return Promise.resolve({
        ok: false as const,
        error: `"${data.id}" is reserved for the built-in provider.`,
      });
    }
    return save({
      id: data.id,
      kind: "oidc",
      label: data.label,
      enabled: data.enabled,
      signup: data.signup,
      trustEmails: data.trustEmails,
      exclusive: data.exclusive,
      clientId: data.clientId,
      ...(data.secret ? { secret: data.secret } : {}),
      config: { discoveryUrl: data.discoveryUrl, scopes: [...data.scopes] },
    });
  });

export const setOAuthProviderEnabled = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(SetOAuthProviderEnabledInput))
  .handler(({ data }) =>
    runtime
      .runPromise(
        Effect.gen(function* () {
          const repo = yield* OAuthRepo;
          const stored = (yield* repo.list()).find((p) => p.id === data.id);
          if (!stored) return { ok: false as const, error: "That provider is gone." };
          if (!data.enabled && (yield* isLastWayIn(data.id)))
            return { ok: false as const, error: LAST_WAY_IN };
          if (data.enabled && !stored.secretConfigured) {
            return { ok: false as const, error: "Add the client secret before enabling this." };
          }
          yield* repo.setEnabled(data.id, data.enabled);
          return { ok: true as const };
        }),
      )
      .then((result) => {
        if (result.ok) invalidateAuth();
        return result;
      }),
  );

export const deleteOAuthProvider = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(OAuthProviderId))
  .handler(async ({ data }) => {
    await runServerFn(
      Effect.gen(function* () {
        if (yield* isLastWayIn(data.id)) return yield* refuse(409, LAST_WAY_IN);
        yield* Effect.flatMap(OAuthRepo, (repo) => repo.remove(data.id));
      }),
    );
    invalidateAuth();
  });
