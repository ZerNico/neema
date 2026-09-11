import { asc, eq } from "drizzle-orm";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import type { JsonValue } from "~/db/schema/providers.ts";
import { oauthProviders } from "~/db/schema/index.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { Db } from "~/server/db.ts";
import { BuiltinOAuthConfig, OidcOAuthConfig, type SignInProvider } from "../oauth.ts";
import type { AuthOAuthProvider } from "./config.ts";

type OAuthProviderRow = typeof oauthProviders.$inferSelect;

// Provider rows safe for admin clients: the ciphertext becomes a boolean, the
// same trade the tools and providers pages make.
export type PublicOAuthProvider = Omit<OAuthProviderRow, "clientSecretCiphertext"> & {
  secretConfigured: boolean;
};

const toPublic = ({ clientSecretCiphertext, ...rest }: OAuthProviderRow): PublicOAuthProvider => ({
  ...rest,
  secretConfigured: clientSecretCiphertext !== null,
});

const orNull = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.catch(() => Effect.succeed(null)));

const skip = (id: string, reason: string) =>
  Effect.logWarning("oauth provider not registered", { id, reason });

const decodeBuiltinConfig = Schema.decodeUnknownEffect(BuiltinOAuthConfig);
const decodeOidcConfig = Schema.decodeUnknownEffect(OidcOAuthConfig);

export interface UpsertOAuthProvider {
  readonly id: string;
  readonly kind: "builtin" | "oidc";
  readonly label: string;
  readonly enabled: boolean;
  readonly trusted: boolean;
  readonly clientId: string;
  /** Absent keeps whatever is stored; a value replaces it. */
  readonly secret?: string | undefined;
  readonly config: Record<string, JsonValue>;
}

export class OAuthRepo extends Context.Service<
  OAuthRepo,
  {
    list(): Effect.Effect<PublicOAuthProvider[]>;
    /**
     * Internal: enabled rows with decrypted secrets, for building the Better
     * Auth instance. A row with no secret or an undecodable config is left out
     * rather than failing the rebuild, which would take every sign-in down.
     */
    listForAuth(): Effect.Effect<AuthOAuthProvider[]>;
    /** Public: what a sign-in button needs, for signed-out callers. */
    listForSignIn(): Effect.Effect<SignInProvider[]>;
    /** Whether accounts this provider creates skip the approval queue. */
    isTrusted(id: string): Effect.Effect<boolean>;
    upsert(input: UpsertOAuthProvider): Effect.Effect<PublicOAuthProvider>;
    remove(id: string): Effect.Effect<void>;
  }
>()("chat/auth/OAuthRepo") {
  static readonly layer = Layer.effect(
    OAuthRepo,
    Effect.gen(function* () {
      const db = yield* Db;
      const cipher = yield* KeyCipher;

      const all = () =>
        db.select().from(oauthProviders).orderBy(asc(oauthProviders.label)).pipe(Effect.orDie);

      return OAuthRepo.of({
        list: Effect.fn("OAuthRepo.list")(function* () {
          return (yield* all()).map(toPublic);
        }),

        listForSignIn: Effect.fn("OAuthRepo.listForSignIn")(function* () {
          return (yield* all())
            .filter((row) => row.enabled)
            .map((row) => ({ id: row.id, label: row.label }));
        }),

        isTrusted: Effect.fn("OAuthRepo.isTrusted")(function* (id) {
          const rows = yield* db
            .select({ trusted: oauthProviders.trusted })
            .from(oauthProviders)
            .where(eq(oauthProviders.id, id))
            .pipe(Effect.orDie);
          return rows[0]?.trusted ?? false;
        }),

        listForAuth: Effect.fn("OAuthRepo.listForAuth")(function* () {
          const configured: AuthOAuthProvider[] = [];
          for (const row of yield* all()) {
            if (!row.enabled) continue;
            if (!row.clientSecretCiphertext) {
              yield* skip(row.id, "no client secret stored");
              continue;
            }
            const clientSecret = Redacted.value(yield* cipher.decrypt(row.clientSecretCiphertext));
            if (row.kind === "oidc") {
              const config = yield* orNull(decodeOidcConfig(row.config));
              if (!config) {
                yield* skip(row.id, "configuration does not decode");
                continue;
              }
              configured.push({
                kind: "oidc",
                id: row.id,
                label: row.label,
                clientId: row.clientId,
                clientSecret,
                discoveryUrl: config.discoveryUrl,
                scopes: config.scopes,
              });
              continue;
            }
            const config = yield* orNull(decodeBuiltinConfig(row.config));
            if (!config) {
              yield* skip(row.id, "configuration does not decode");
              continue;
            }
            configured.push({
              kind: "builtin",
              id: row.id,
              clientId: row.clientId,
              clientSecret,
              tenantId: config.tenantId,
              issuer: config.issuer,
            });
          }
          return configured;
        }),

        upsert: Effect.fn("OAuthRepo.upsert")(function* (input) {
          const clientSecretCiphertext = input.secret
            ? yield* cipher.encrypt(input.secret)
            : undefined;
          const now = new Date();
          const rows = yield* db
            .insert(oauthProviders)
            .values({
              id: input.id,
              kind: input.kind,
              label: input.label,
              enabled: input.enabled,
              trusted: input.trusted,
              clientId: input.clientId,
              clientSecretCiphertext: clientSecretCiphertext ?? null,
              config: input.config,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: oauthProviders.id,
              set: {
                label: input.label,
                enabled: input.enabled,
                trusted: input.trusted,
                clientId: input.clientId,
                // An omitted secret keeps the stored one, so the admin form
                // never has to round-trip a value it cannot display.
                ...(clientSecretCiphertext ? { clientSecretCiphertext } : {}),
                config: input.config,
                updatedAt: now,
              },
            })
            .returning()
            .pipe(Effect.orDie);
          const row = rows[0];
          if (!row) return yield* Effect.die("oauth provider upsert returned no row");
          return toPublic(row);
        }),

        remove: Effect.fn("OAuthRepo.remove")(function* (id) {
          yield* db.delete(oauthProviders).where(eq(oauthProviders.id, id)).pipe(Effect.orDie);
        }),
      });
    }),
  );
}
