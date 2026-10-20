import { queryOptions } from "@tanstack/react-query";
import { authClient } from "./client.ts";
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

/** The signed-in person's own provider accounts, as Better Auth lists them. */
export const linkedAccountsQuery = queryOptions({
  queryKey: ["linked-accounts"],
  queryFn: async () => {
    const { data, error } = await authClient.listAccounts();
    if (error) throw new Error(error.message);
    return data;
  },
});
