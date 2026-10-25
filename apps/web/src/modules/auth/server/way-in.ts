import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { account, oauthProviders } from "~/db/schema/index.ts";
import { Db } from "~/server/db.ts";
import { refuse } from "~/server/refusal.ts";
import { localized } from "~/i18n/localized.ts";
import { m } from "~/paraglide/messages.js";
import { baseLocale } from "~/paraglide/runtime.js";
import { passwordLoginForced } from "./password-login.ts";
import { SignupRepo } from "./signup-repo.ts";

/** A change that could take someone's last way in: each path names only its own. */
export interface WayInChange {
  /** Password sign-in as it would be after the change. */
  readonly passwordLogin?: boolean;
  /** A provider being switched off or deleted. */
  readonly providerOff?: string;
  /** The id of an account row being unlinked. */
  readonly unlinking?: string;
}

export const NO_WAY_IN = m.auth_error_no_way_in({}, { locale: baseLocale });

/**
 * Whether this person could still sign in after the change: with their
 * password while password sign-in is on, or through an account on an enabled
 * provider. The operator's override is a way in whatever is stored.
 */
export const keepsWayIn = Effect.fn("auth.keepsWayIn")(function* (
  userId: string,
  change: WayInChange,
) {
  if (passwordLoginForced()) return true;
  const settings = yield* SignupRepo.use((repo) => repo.settings());
  const passwordLogin = change.passwordLogin ?? settings.passwordLogin;
  const db = yield* Db;
  const accounts = yield* db
    .select({ id: account.id, providerId: account.providerId, enabled: oauthProviders.enabled })
    .from(account)
    .leftJoin(oauthProviders, eq(oauthProviders.id, account.providerId))
    .where(eq(account.userId, userId))
    .pipe(Effect.orDie);
  return accounts.some((row) =>
    row.id === change.unlinking
      ? false
      : row.providerId === "credential"
        ? passwordLogin
        : row.enabled === true && row.providerId !== change.providerOff,
  );
});

/** Refuses the change when it would lock the acting person out. */
export const requireWayIn = (userId: string, change: WayInChange) =>
  keepsWayIn(userId, change).pipe(
    Effect.flatMap((keeps) =>
      keeps ? Effect.void : refuse(409, localized(m.auth_error_no_way_in)),
    ),
  );
