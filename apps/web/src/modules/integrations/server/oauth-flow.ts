import { isIP } from "node:net";
import { and, eq, gt } from "drizzle-orm";
import { Effect } from "effect";
import { uuidv7 } from "uuidv7";
import { verification } from "~/db/schema/index.ts";
import { Db } from "~/server/db.ts";
import { publicUrl } from "~/server/public-url.ts";
import { IntegrationRejected } from "../errors.ts";
import {
  authorizeUrl,
  callbackPath,
  OAUTH_STATE_TTL_MS,
  randomToken,
  requestTokens,
  sha256,
} from "./oauth.ts";
import { IntegrationRepo, type DiscoveredServer } from "./repo.ts";
import { methodsFor, verified, type makeCredentials } from "./credentials.ts";

const signInOutdated = () =>
  new IntegrationRejected({
    reason: "This integration’s setup changed during the sign-in. Start again from Settings.",
  });

/**
 * Where an authorization server could fetch this app's client metadata
 * document: only an operator-declared public HTTPS address, since a server
 * that cannot reach the document fails the whole sign-in. Without one, the
 * app registers itself instead.
 */
const metadataDocumentOrigin = () => {
  const declared = publicUrl();
  if (!declared?.startsWith("https://")) return null;
  const host = new URL(declared).hostname;
  const local =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    isIP(host.replace(/^\[|\]$/g, "")) !== 0 ||
    !host.includes(".");
  return local ? null : declared;
};

const stateIdentifier = (state: string) => `integration-oauth:${sha256(state)}`;

interface OAuthStateValue {
  userId: string;
  integrationId: string;
  verifier: string;
  redirectUri: string;
  /** A path on this app to land on afterwards; validated when it was given. */
  returnTo?: string;
  /** Recorded when the sign-in was discovered: where the code goes, and who must answer. */
  server?: DiscoveredServer;
  /**
   * The integration's revision the sign-in started under. Tokens are only
   * kept for that one: a setup changed meanwhile must not get them.
   */
  revision?: number;
}

/**
 * Signing a person in to an integration: the state that ties a callback to
 * the browser and setup that started it, and the token exchange after it.
 */
export const makeOAuthFlow = (deps: {
  credentials: Pick<
    Effect.Success<ReturnType<typeof makeCredentials>>,
    "available" | "discoveredSecret"
  >;
  changed: (userId: string) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const repo = yield* IntegrationRepo;
    const { available, discoveredSecret } = deps.credentials;
    const { changed } = deps;

    const beginOAuth = Effect.fn("IntegrationService.beginOAuth")(function* (
      userId: string,
      integrationId: string,
      origin: string,
      returnTo?: string,
    ) {
      const { manifest, adapter, row, config } = yield* available(userId, integrationId);
      const state = randomToken();
      const redirectUri = `${origin}${callbackPath(integrationId)}`;
      const store = (value: OAuthStateValue) =>
        db
          .insert(verification)
          .values({
            id: uuidv7(),
            identifier: stateIdentifier(state),
            value: JSON.stringify(value),
            expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
          })
          .pipe(Effect.orDie);
      const discovered = adapter.discoveredOAuth;
      if (discovered) {
        if (!methodsFor(manifest, adapter, row, config, false).oauth)
          return yield* new IntegrationRejected({
            reason: "This integration does not use sign-in.",
          });
        // A step-up keeps what was granted and asks for what a call lacked.
        const connection = yield* repo.getConnection(userId, integrationId);
        const previous = connection ? yield* repo.decrypt(connection) : null;
        const granted = previous?.kind === "oauth" && previous.server ? previous.server.scopes : [];
        const started = yield* discovered.begin({
          config,
          integrationId,
          integrationName: row.name,
          redirectUri,
          clientMetadataUrl: metadataDocumentOrigin()
            ? `${metadataDocumentOrigin()}/api/integrations/${integrationId}/oauth-client`
            : null,
          state,
          scopes: { granted, required: connection?.requiredScopes ?? [] },
          preregistered: row.oauthClientId
            ? {
                clientId: row.oauthClientId,
                clientSecret: yield* repo.clientSecret(row),
                pin: (issuer: string) => repo.pinClientIssuer(integrationId, row.revision, issuer),
              }
            : null,
          storedClient: (issuer) => repo.reusableOAuthClient(integrationId, issuer, redirectUri),
          saveClient: (issuer, client) => repo.saveOAuthClient(integrationId, issuer, client),
        });
        yield* store({
          userId,
          integrationId,
          verifier: started.verifier,
          redirectUri,
          server: started.server,
          revision: row.revision,
          ...(returnTo ? { returnTo } : {}),
        });
        return { state, url: started.url };
      }
      if (!adapter.oauth || !row.oauthClientId || !row.oauthClientSecretCiphertext)
        return yield* new IntegrationRejected({
          reason: "OAuth is not set up for this integration.",
        });
      const verifier = randomToken();
      const value: OAuthStateValue = {
        userId,
        integrationId,
        verifier,
        redirectUri,
        revision: row.revision,
        ...(returnTo ? { returnTo } : {}),
      };
      yield* store(value);
      return {
        state,
        url: authorizeUrl({
          endpoint: adapter.oauth.authorizeUrl(config),
          clientId: row.oauthClientId,
          redirectUri,
          scopes: adapter.oauth.scopes,
          state,
          verifier,
        }),
      };
    });

    const completeOAuth = Effect.fn("IntegrationService.completeOAuth")(function* (
      userId: string,
      integrationId: string,
      input: { code: string; state: string; cookieState: string | null; iss: string | null },
    ) {
      const expired = new IntegrationRejected({
        reason:
          "This sign-in link expired or was opened in another browser. Start again from Settings.",
      });
      // The cookie ties the callback to the browser that started it: a
      // stranger's authorization link cannot land their account in ours.
      if (!input.cookieState || input.cookieState !== input.state) return yield* expired;
      const consumed = yield* db
        .delete(verification)
        .where(
          and(
            eq(verification.identifier, stateIdentifier(input.state)),
            gt(verification.expiresAt, new Date()),
          ),
        )
        .returning()
        .pipe(Effect.orDie);
      const stored = consumed[0] ? (JSON.parse(consumed[0].value) as OAuthStateValue) : null;
      if (!stored || stored.userId !== userId || stored.integrationId !== integrationId)
        return yield* expired;
      const { adapter, row, config, fingerprint } = yield* available(userId, integrationId);
      if (stored.revision !== row.revision) return yield* signInOutdated();
      if (stored.server && adapter.discoveredOAuth) {
        const tokens = yield* adapter.discoveredOAuth.complete({
          server: stored.server,
          clientSecret: yield* discoveredSecret(row, stored.server),
          code: input.code,
          iss: input.iss,
          verifier: stored.verifier,
          redirectUri: stored.redirectUri,
        });
        const { accountLabel } = yield* verified(adapter, config, {
          kind: "oauth",
          accessToken: tokens.accessToken,
        });
        // The exchange took time: a save meanwhile may have moved the
        // integration to another client or server, so the write checks again.
        const saved = yield* repo.saveConnection({
          userId,
          integrationId,
          revision: stored.revision,
          authKind: "oauth",
          credentials: { kind: "oauth", ...tokens, server: stored.server },
          accountLabel,
          fingerprint,
        });
        if (!saved) return yield* signInOutdated();
        yield* repo.clearRequiredScopes(saved.id);
        yield* changed(userId);
        return { returnTo: stored.returnTo ?? null };
      }
      if (!adapter.oauth || !row.oauthClientId) return yield* expired;
      const outcome = yield* requestTokens({
        endpoint: adapter.oauth.tokenUrl(config),
        clientId: row.oauthClientId,
        clientSecret: yield* repo.clientSecret(row),
        params: {
          grant_type: "authorization_code",
          code: input.code,
          redirect_uri: stored.redirectUri,
          code_verifier: stored.verifier,
        },
      }).pipe(
        Effect.catchTag("IntegrationRequestFailed", (error) =>
          Effect.fail(new IntegrationRejected({ reason: error.message })),
        ),
      );
      if (!outcome.ok)
        return yield* new IntegrationRejected({
          reason: "The service refused the sign-in. Try again.",
        });
      const { accountLabel } = yield* verified(adapter, config, {
        kind: "oauth",
        accessToken: outcome.tokens.accessToken,
      });
      const saved = yield* repo.saveConnection({
        userId,
        integrationId,
        revision: stored.revision,
        authKind: "oauth",
        credentials: { kind: "oauth", ...outcome.tokens },
        accountLabel,
        fingerprint,
      });
      if (!saved) return yield* signInOutdated();
      yield* changed(userId);
      return { returnTo: stored.returnTo ?? null };
    });

    return { beginOAuth, completeOAuth };
  });
