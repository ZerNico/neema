import { Effect, Option } from "effect";
import { eligibleAdmin } from "~/modules/auth/server/account-eligibility.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { findIntegrationType, INTEGRATION_TYPES } from "../catalog.ts";
import { IntegrationRejected } from "../errors.ts";
import type { AdminCatalog } from "../schema.ts";
import type { CatalogDecision, Credential } from "./adapter.ts";
import { findAdapterType } from "./adapters.ts";
import { IntegrationRepo, type ToolCatalogRow } from "./repo.ts";
import { methodsFor, probe, type makeCredentials } from "./credentials.ts";

/** How soon a catalog is looked at again after a check failed, and by default after one worked. */
const CATALOG_RETRY_MS = 60 * 60_000;
const CATALOG_RECHECK_MS = 24 * 60 * 60_000;

const failureReason = (error: { _tag: string }) =>
  error._tag === "IntegrationAuthFailed"
    ? "The server refused the sign-in used to list its tools."
    : "reason" in error && typeof error.reason === "string"
      ? error.reason
      : "message" in error && typeof error.message === "string"
        ? error.message
        : "The server could not be reached.";

/**
 * What a review names: this listing, and how many approvals came before, so
 * a review approves exactly what it showed and two admins cannot both win.
 */
const reviewVersion = (row: ToolCatalogRow) => `${row.listingId}.${row.reviewSeq}`;

export const toCatalog = (row: ToolCatalogRow | null): AdminCatalog => ({
  approved: row?.approved ?? [],
  latest: row?.latest ?? null,
  server: row?.server ?? null,
  checkedAt: row?.checkedAt?.toISOString() ?? null,
  checkError: row?.checkError ?? null,
  reviewedAt: row?.reviewedAt?.toISOString() ?? null,
  version: row?.latest && row.listingId ? reviewVersion(row) : null,
});

/**
 * Tool catalogs of servers that list their own tools: checking what a server
 * lists, an admin approving it, and the sweep that checks again when due.
 */
export const makeCatalogService = (deps: {
  credentials: Pick<Effect.Success<ReturnType<typeof makeCredentials>>, "sessionFor">;
}) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const repo = yield* IntegrationRepo;
    const bus = yield* SyncBus;
    const { sessionFor } = deps.credentials;

    /**
     * A session to list a catalog with. An open or shared server needs nobody;
     * otherwise it is a person's own connection, since listing may show what
     * only an account can see.
     */
    const catalogSession = Effect.fn(function* (integrationId: string, userId: string | null) {
      const row = yield* repo.getConfig(integrationId);
      const manifest = row ? findIntegrationType(row.kind) : null;
      const adapter = row ? findAdapterType(row.kind) : null;
      const catalog = adapter?.catalog;
      if (!row || !manifest || !adapter || !catalog)
        return yield* new IntegrationRejected({
          reason: "This integration does not list its own tools.",
        });
      // A switched-off integration reaches nobody, the admin's key included.
      if (!row.enabled)
        return yield* new IntegrationRejected({ reason: `Turn ${row.name} on first.` });
      const normalized = adapter.normalizeConfig(row.config);
      if ("error" in normalized)
        return yield* new IntegrationRejected({ reason: normalized.error });
      const methods = methodsFor(
        manifest,
        adapter,
        row,
        normalized.config,
        Boolean(row.sharedCredentialCiphertext),
      );
      if (methods.open === "shared") {
        const shared = yield* repo.sharedCredential(row);
        if (!shared)
          return yield* new IntegrationRejected({ reason: "Enter the shared key first." });
        const credential: Credential = { kind: "api_key", values: shared };
        return { row, adapter, catalog, session: probe(normalized.config, credential) };
      }
      // The reviewer's own account first: it may see tools nobody sees without one.
      const own = userId
        ? yield* sessionFor(userId, integrationId).pipe(Effect.option)
        : Option.none();
      if (Option.isSome(own)) return { row, adapter, catalog, session: own.value };
      if (methods.open === "none")
        return { row, adapter, catalog, session: probe(normalized.config, { kind: "none" }) };
      return yield* new IntegrationRejected({
        reason: `Turn ${row.name} on and connect your own account in Settings, then check again.`,
      });
    });

    const checkCatalog = Effect.fn("IntegrationService.checkCatalog")(function* (
      integrationId: string,
      asUserId: string | null,
    ) {
      const token = yield* repo.startCatalogCheck(integrationId);
      const current = yield* repo.catalog(integrationId);
      // Recorded only for the setup the check started under: a move meanwhile drops it.
      const setup = yield* repo.getConfig(integrationId);
      const started = setup?.revision ?? 0;
      const owner = setup?.ownerUserId ?? null;
      const fail = (reason: string) =>
        repo
          .recordCatalogCheck(
            integrationId,
            { token, revision: started },
            { error: reason },
            new Date(Date.now() + CATALOG_RETRY_MS),
          )
          .pipe(Effect.andThen(Effect.fail(new IntegrationRejected({ reason }))));
      // The sweep lists as the last reviewer only while that account may act and
      // is still an admin, as an admin's own request must be. A personal server
      // lists as its owner while they may still use it, else not at all.
      const reviewer = asUserId ? null : (owner ?? current?.reviewedBy ?? null);
      const eligible =
        reviewer !== null &&
        (owner
          ? yield* repo.isUsable(owner, integrationId)
          : yield* eligibleAdmin(reviewer).pipe(Effect.provideService(Db, db)));
      if (owner && !asUserId && !eligible) return yield* fail("Its owner can no longer use it.");
      const context = yield* catalogSession(
        integrationId,
        asUserId ?? (eligible ? reviewer : null),
      ).pipe(Effect.catch((error) => fail(error.reason)));
      if (context.row.revision !== started)
        return yield* fail("The integration changed while it was being checked. Check again.");
      // Approved names win, so nothing approved is renamed for the model.
      const previous = [...(current?.latest ?? []), ...(current?.approved ?? [])];
      const listed = yield* context.catalog
        .list(context.session, integrationId, previous)
        .pipe(Effect.catch((error) => fail(failureReason(error))));
      const next = new Date(Date.now() + (listed.recheckAfterMs ?? CATALOG_RECHECK_MS));
      // A newer check, or the admin moving the server, made this listing stale: drop it.
      const recorded = yield* repo.recordCatalogCheck(
        integrationId,
        { token, revision: started },
        { latest: listed.entries, server: listed.server },
        next,
      );
      if (!recorded)
        return yield* new IntegrationRejected({
          reason: "A newer check of this server replaced this one. Look again.",
        });
      yield* bus
        .publishGlobal({ type: "integrations.changed" })
        .pipe(Effect.catchCause(() => Effect.void));
      return toCatalog(yield* repo.catalog(integrationId));
    });

    const approveCatalog = Effect.fn("IntegrationService.approveCatalog")(function* (
      adminId: string,
      integrationId: string,
      input: { version: string; decisions: ReadonlyArray<CatalogDecision> },
    ) {
      const row = yield* repo.getConfig(integrationId);
      const adapter = row ? findAdapterType(row.kind) : null;
      const catalog = adapter?.catalog;
      if (!row || !adapter || !catalog)
        return yield* new IntegrationRejected({
          reason: "This integration does not list its own tools.",
        });
      const current = yield* repo.catalog(integrationId);
      if (!current?.latest || !current.listingId)
        return yield* new IntegrationRejected({ reason: "Check the server’s tools first." });
      const outdated = new IntegrationRejected({
        reason: "The server’s tools changed while you were looking. Review them again.",
      });
      // Approving is approving what was seen: another listing, or another
      // approval since, is shown again rather than overwritten.
      if (reviewVersion(current) !== input.version) return yield* outdated;
      const applied = catalog.apply(current.approved, current.latest, input.decisions);
      if ("error" in applied) return yield* new IntegrationRejected({ reason: applied.error });
      const written = yield* repo.approveCatalog(integrationId, applied.approved, adminId, {
        listingId: current.listingId,
        reviewSeq: current.reviewSeq,
      });
      if (!written) return yield* outdated;
      yield* bus
        .publishGlobal({ type: "integrations.changed" })
        .pipe(Effect.catchCause(() => Effect.void));
      return toCatalog(yield* repo.catalog(integrationId));
    });

    const checkDueCatalogs = Effect.fn("IntegrationService.checkDueCatalogs")(function* () {
      const kinds = INTEGRATION_TYPES.filter((type) => type.toolSource === "catalog").map(
        (type) => type.kind,
      );
      const claimed = yield* repo.claimCatalogChecks({ kinds, limit: 5, leaseMs: 5 * 60_000 });
      yield* Effect.forEach(
        claimed,
        (entry) => checkCatalog(entry.integrationId, null).pipe(Effect.ignore),
        { concurrency: 3, discard: true },
      );
    });

    return { checkCatalog, approveCatalog, checkDueCatalogs };
  });
