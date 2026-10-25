import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import type { JsonValue } from "~/db/schema/providers.ts";
import { publicUrl } from "~/server/public-url.ts";
import { refuse } from "~/server/refusal.ts";
import { runServerFn } from "~/server/run-server-fn.ts";
import {
  findBuiltin,
  OAuthProviderId,
  SaveBuiltinProviderInput,
  SaveOidcProviderInput,
  SetOAuthProviderEnabledInput,
} from "../oauth.ts";
import { invalidateAuth } from "./auth.ts";
import { requireAdmin } from "./middleware.ts";
import { OAuthRepo, type UpsertOAuthProvider } from "./oauth-repo.ts";
import { requireWayIn } from "./way-in.ts";

const standard = Schema.toStandardSchemaV1;

/** Every refusal here is thrown, so the page reads each one from the error alone. */
const save = async (actorId: string, input: UpsertOAuthProvider) => {
  const provider = await runServerFn(
    Effect.gen(function* () {
      const repo = yield* OAuthRepo;
      if (!input.enabled) yield* requireWayIn(actorId, { providerOff: input.id });
      if (input.enabled && !input.secret) {
        const stored = (yield* repo.list()).find((p) => p.id === input.id);
        if (!stored?.secretConfigured)
          return yield* refuse(400, "Enter the client secret before enabling this.");
      }
      return yield* repo.upsert(input);
    }),
  );
  invalidateAuth();
  return provider;
};

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
  .handler(({ data, context }) => {
    const builtin = findBuiltin(data.id);
    if (!builtin) return runServerFn(refuse(400, "Unknown provider."));
    const config: Record<string, JsonValue> = {};
    // Only the field this provider actually reads is stored, so switching
    // catalogue entries cannot leave another provider's setting behind.
    if (builtin.field?.key === "tenantId" && data.tenantId) config.tenantId = data.tenantId;
    if (builtin.field?.key === "issuer" && data.issuer) config.issuer = data.issuer;
    return save(context.session.user.id, {
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
  .handler(({ data, context }) => {
    if (findBuiltin(data.id))
      return runServerFn(refuse(400, `"${data.id}" is reserved for the built-in provider.`));
    return save(context.session.user.id, {
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
  .handler(async ({ data, context }) => {
    await runServerFn(
      Effect.gen(function* () {
        const repo = yield* OAuthRepo;
        const stored = (yield* repo.list()).find((p) => p.id === data.id);
        if (!stored) return yield* refuse(409, "That provider is gone.");
        if (!data.enabled) yield* requireWayIn(context.session.user.id, { providerOff: data.id });
        if (data.enabled && !stored.secretConfigured)
          return yield* refuse(400, "Add the client secret before enabling this.");
        yield* repo.setEnabled(data.id, data.enabled);
      }),
    );
    invalidateAuth();
  });

export const deleteOAuthProvider = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(OAuthProviderId))
  .handler(async ({ data, context }) => {
    await runServerFn(
      Effect.gen(function* () {
        yield* requireWayIn(context.session.user.id, { providerOff: data.id });
        yield* OAuthRepo.use((repo) => repo.remove(data.id));
      }),
    );
    invalidateAuth();
  });
