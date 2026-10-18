import { and, desc, eq, max, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  verification,
} from "~/db/schema/index.ts";
import { Db } from "~/server/db.ts";

/** One app a person let in, as Settings lists it. */
export interface ConnectedApp {
  clientId: string;
  name: string;
  /** Set only when the client registered by metadata document: the host it was fetched from. */
  verifiedHost: string | null;
  scopes: ReadonlyArray<string>;
  connectedAt: Date;
  /** When it last obtained a token, which it does hourly while in use. */
  lastActiveAt: Date | null;
}

/** What the consent page shows about the asking app. */
export interface ConsentClient {
  name: string;
  verifiedHost: string | null;
  scopes: ReadonlyArray<string>;
}

/** A metadata-document client's id is the https URL its metadata came from. */
const verifiedHostOf = (clientId: string, discoveryId: string | null) => {
  if (!discoveryId) return null;
  try {
    return new URL(clientId).host;
  } catch {
    return null;
  }
};

const nameOf = (name: string | null, clientId: string, discoveryId: string | null) =>
  name?.trim() || verifiedHostOf(clientId, discoveryId) || "Unnamed app";

export class ConnectedApps extends Context.Service<
  ConnectedApps,
  {
    list(userId: string): Effect.Effect<ReadonlyArray<ConnectedApp>>;
    client(clientId: string): Effect.Effect<ConsentClient | null>;
    /** Ends the app's access at once: its consent, its tokens and any code not yet exchanged. */
    revoke(userId: string, clientId: string): Effect.Effect<void>;
  }
>()("chat/mcp-server/ConnectedApps") {
  static readonly layer = Layer.effect(
    ConnectedApps,
    Effect.gen(function* () {
      const db = yield* Db;
      return {
        list: Effect.fn("ConnectedApps.list")(function* (userId: string) {
          const lastActive = db
            .select({
              clientId: oauthAccessToken.clientId,
              at: max(oauthAccessToken.createdAt).as("at"),
            })
            .from(oauthAccessToken)
            .where(eq(oauthAccessToken.userId, userId))
            .groupBy(oauthAccessToken.clientId)
            .as("last_active");
          const rows = yield* db
            .select({
              clientId: oauthConsent.clientId,
              name: oauthClient.name,
              discoveryId: oauthClient.clientDiscoveryId,
              scopes: oauthConsent.scopes,
              connectedAt: oauthConsent.createdAt,
              lastActiveAt: lastActive.at,
            })
            .from(oauthConsent)
            .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
            .leftJoin(lastActive, eq(lastActive.clientId, oauthConsent.clientId))
            .where(eq(oauthConsent.userId, userId))
            .orderBy(desc(sql`coalesce(${lastActive.at}, ${oauthConsent.createdAt})`))
            .pipe(Effect.orDie);
          return rows.map((row) => ({
            clientId: row.clientId,
            name: nameOf(row.name, row.clientId, row.discoveryId),
            verifiedHost: verifiedHostOf(row.clientId, row.discoveryId),
            scopes: row.scopes,
            connectedAt: row.connectedAt,
            lastActiveAt: row.lastActiveAt,
          }));
        }),
        client: Effect.fn("ConnectedApps.client")(function* (clientId: string) {
          const [row] = yield* db
            .select({
              name: oauthClient.name,
              discoveryId: oauthClient.clientDiscoveryId,
              scopes: oauthClient.scopes,
              disabled: oauthClient.disabled,
            })
            .from(oauthClient)
            .where(eq(oauthClient.clientId, clientId))
            .pipe(Effect.orDie);
          if (!row || row.disabled) return null;
          return {
            name: nameOf(row.name, clientId, row.discoveryId),
            verifiedHost: verifiedHostOf(clientId, row.discoveryId),
            scopes: row.scopes ?? [],
          };
        }),
        revoke: Effect.fn("ConnectedApps.revoke")(function* (userId: string, clientId: string) {
          yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const owned = (table: typeof oauthAccessToken | typeof oauthRefreshToken) =>
                  and(eq(table.userId, userId), eq(table.clientId, clientId));
                // Access tokens first: those a refresh token minted would
                // cascade anyway, but not one minted by a code exchange.
                yield* tx.delete(oauthAccessToken).where(owned(oauthAccessToken));
                yield* tx.delete(oauthRefreshToken).where(owned(oauthRefreshToken));
                yield* tx
                  .delete(oauthConsent)
                  .where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)));
                // A code already handed out would still exchange for tokens: the
                // provider checks the code, not that consent survives.
                yield* tx.delete(verification).where(
                  sql`case when ${verification.value} like '{"type":"authorization_code"%'
                    then ${verification.value}::jsonb ->> 'userId' = ${userId}
                      and ${verification.value}::jsonb -> 'query' ->> 'client_id' = ${clientId}
                    else false end`,
                );
              }),
            )
            .pipe(Effect.orDie);
        }),
      };
    }),
  );
}
