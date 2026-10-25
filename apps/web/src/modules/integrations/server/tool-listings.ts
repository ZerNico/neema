import { m } from "~/paraglide/messages.js";
import { Duration, Effect } from "effect";
import { accountEligible } from "~/modules/auth/server/account-eligibility.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { findIntegrationType, INTEGRATION_TYPES } from "../catalog.ts";
import { english, type Localized, localized, verbatim } from "~/i18n/localized.ts";
import { IntegrationRejected } from "../errors.ts";
import { usesNoAccount, type IntegrationConnectionView, type ToolListingView } from "../schema.ts";
import type { Credential } from "./adapter.ts";
import { findAdapterType } from "./adapters.ts";
import { methodsFor, probe, type makeCredentials } from "./credentials.ts";
import { IntegrationRepo, type ToolListingRow } from "./repo.ts";

/** How soon a listing is looked at again after a check failed, and by default after one worked. */
const LISTING_RETRY_MS = 60 * 60_000;
const LISTING_RECHECK_MS = 24 * 60 * 60_000;
/** Listings one sweep round checks at most: this many batches of this many. */
const SWEEP_BATCH = 25;
const SWEEP_BATCHES = 20;

const failureReason = (error: { _tag: string }) =>
  error._tag === "IntegrationAuthFailed"
    ? "The server refused the account’s sign-in."
    : error instanceof IntegrationRejected
      ? english(error.reason)
      : "message" in error && typeof error.message === "string"
        ? error.message
        : "The server could not be reached.";

/**
 * Whose listing an account's tools come from: its own, or the one without
 * an account when it signs in as nobody (open, or the admin's key), since
 * every such account sees the same tools.
 */
export const listingOwner = (connection: {
  id: string;
  authKind: IntegrationConnectionView["authKind"];
}) => (usesNoAccount(connection.authKind) ? null : connection.id);

export const toListingView = (row: ToolListingRow | null): ToolListingView | null =>
  row && {
    server: row.server ?? null,
    checkedAt: row.checkedAt?.toISOString() ?? null,
    checkError: row.checkError,
    count: row.tools?.length ?? null,
  };

/**
 * Tools of servers that list their own, per account: checking what a server
 * lists, and the sweep that checks again when due. Each listing is checked
 * with the account it belongs to, so it shows only what that account sees.
 */
export const makeToolListings = (deps: {
  credentials: Pick<Effect.Success<ReturnType<typeof makeCredentials>>, "sessionFor">;
}) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const repo = yield* IntegrationRepo;
    const bus = yield* SyncBus;
    const { sessionFor } = deps.credentials;

    const listTools = Effect.fn("IntegrationService.listTools")(function* (
      integrationId: string,
      connectionId: string | null,
    ) {
      const row = yield* repo.getConfig(integrationId);
      const manifest = row ? findIntegrationType(row.kind) : null;
      const adapter = row ? findAdapterType(row.kind) : null;
      const lister = adapter?.listing;
      if (!row || !manifest || !adapter || !lister)
        return yield* new IntegrationRejected({
          reason: localized(m.integrations_error_not_listed),
        });
      const token = yield* repo.startListing(integrationId, connectionId);
      if (!token)
        return yield* new IntegrationRejected({
          reason: localized(m.integrations_error_account_removed),
        });
      // Recorded only for the setup the check started under: a move meanwhile drops it.
      const started = { token, revision: row.revision };
      const listingId = connectionId ?? integrationId;
      // Kept in English: one listing may be read by several admins, each in their own language.
      const fail = (reason: Localized) =>
        repo
          .recordListing(
            listingId,
            started,
            { error: english(reason) },
            new Date(Date.now() + LISTING_RETRY_MS),
          )
          .pipe(Effect.andThen(Effect.fail(new IntegrationRejected({ reason }))));
      // A switched-off integration reaches nobody, the admin's key included.
      if (!row.enabled)
        return yield* fail(localized(m.integrations_error_turned_off, { name: row.name }));
      const normalized = adapter.normalizeConfig(row.config);
      if ("error" in normalized) return yield* fail(normalized.error);

      // Whose account this listing is, to tell only them it changed.
      let owner: string | null = null;
      const session = connectionId
        ? yield* Effect.gen(function* () {
            const connection = yield* repo.getConnectionById(connectionId);
            if (!connection) return yield* fail(localized(m.integrations_error_account_removed));
            owner = connection.userId;
            // Their own credential, used unattended by the sweep only while the account may
            // still act here, as its own requests must: approved, not banned, and allowed in.
            const eligible = yield* accountEligible(connection.userId).pipe(
              Effect.provideService(Db, db),
            );
            if (!eligible) return yield* fail(localized(m.integrations_error_owner_cannot_use));
            return yield* sessionFor(connection.userId, connectionId).pipe(
              Effect.catch(() => fail(localized(m.integrations_error_owner_cannot_use))),
            );
          })
        : yield* Effect.gen(function* () {
            const methods = methodsFor(
              manifest,
              adapter,
              row,
              normalized.config,
              Boolean(row.sharedCredentialCiphertext),
            );
            if (methods.open === "none") return probe(normalized.config, { kind: "none" });
            const shared = methods.open === "shared" ? yield* repo.sharedCredential(row) : null;
            if (!shared) return yield* fail(localized(m.integrations_error_lists_per_account));
            const credential: Credential = { kind: "api_key", values: shared };
            return probe(normalized.config, credential);
          });

      // Every account's names count, so one tool keeps one model-facing name for all of them.
      const all = yield* repo.toolListings(integrationId);
      const before = all.find((listing) => listing.id === listingId);
      const previous = all.flatMap((listing) => listing.tools ?? []);
      const listed = yield* lister
        .list(session, integrationId, previous)
        .pipe(Effect.catch((error) => fail(verbatim(failureReason(error)))));
      const next = new Date(Date.now() + (listed.recheckAfterMs ?? LISTING_RECHECK_MS));
      // A newer check, or the admin moving the server, made this listing stale: drop it.
      const recorded = yield* repo.recordListing(
        listingId,
        started,
        { tools: listed.entries, server: listed.server },
        next,
      );
      if (!recorded)
        return yield* new IntegrationRejected({
          reason: localized(m.integrations_error_check_raced),
        });
      // Most checks find what was there; only a change is news, and an account's only to its owner.
      const changed =
        JSON.stringify(before?.tools ?? null) !== JSON.stringify(listed.entries) ||
        JSON.stringify(before?.server ?? null) !== JSON.stringify(listed.server);
      if (changed)
        yield* (
          owner === null
            ? bus.publishGlobal({ type: "integrations.changed" })
            : bus.publish(owner, { type: "integrations.changed" })
        ).pipe(Effect.catchCause(() => Effect.void));
      return toListingView(yield* repo.toolListing(integrationId, connectionId))!;
    });

    /**
     * What a new or reconnected account sees, listed at once so it has tools
     * straight away. The connection is saved already, so nothing here fails
     * the request that made it: a slow server is left to the sweep, which
     * finds the listing due.
     */
    const listForConnection = (connection: {
      id: string;
      integrationId: string;
      authKind: IntegrationConnectionView["authKind"];
    }) =>
      Effect.gen(function* () {
        const owner = listingOwner(connection);
        // The shared listing is everyone's: one already there is the sweep's to refresh.
        if (owner === null && (yield* repo.toolListing(connection.integrationId, null))) return;
        yield* listTools(connection.integrationId, owner);
      }).pipe(
        Effect.timeout(Duration.seconds(20)),
        Effect.catchCause(() => Effect.void),
      );

    /**
     * Everything due, a batch at a time, so one listing per account keeps up:
     * a round stops once a batch comes back short, or at its cap, the rest
     * left for the next round rather than one round running on.
     */
    const checkDueListings = Effect.fn("IntegrationService.checkDueListings")(function* () {
      const kinds = INTEGRATION_TYPES.filter((type) => type.toolSource === "listed").map(
        (type) => type.kind,
      );
      for (let batch = 0; batch < SWEEP_BATCHES; batch++) {
        const claimed = yield* repo.claimDueListings({
          kinds,
          limit: SWEEP_BATCH,
          leaseMs: 5 * 60_000,
        });
        // One server's listings one after another: each reads the names the last one
        // recorded, so two accounts never give two different tools one model-facing name.
        const byIntegration = Map.groupBy(claimed, (entry) => entry.integrationId);
        yield* Effect.forEach(
          byIntegration.values(),
          (entries) =>
            Effect.forEach(
              entries,
              (entry) => listTools(entry.integrationId, entry.connectionId).pipe(Effect.ignore),
              { discard: true },
            ),
          { concurrency: 5, discard: true },
        );
        if (claimed.length < SWEEP_BATCH) return;
      }
    });

    return { listTools, listForConnection, checkDueListings };
  });
