import { queryOptions } from "@tanstack/react-query";
import { listOAuthProviders } from "./server/oauth-functions.ts";
import {
  getAuthSettings,
  getSignInOptions,
  listPendingAccounts,
} from "./server/signup-functions.ts";

export const oauthProvidersQuery = queryOptions({
  queryKey: ["admin", "oauth"],
  queryFn: () => listOAuthProviders(),
});

export const authSettingsQuery = queryOptions({
  queryKey: ["admin", "auth-settings"],
  queryFn: () => getAuthSettings(),
});

export const pendingAccountsQuery = queryOptions({
  queryKey: ["admin", "pending-accounts"],
  queryFn: () => listPendingAccounts(),
});

export const signInOptionsQuery = queryOptions({
  queryKey: ["sign-in-options"],
  queryFn: () => getSignInOptions(),
});
