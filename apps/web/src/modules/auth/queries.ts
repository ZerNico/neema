import { queryOptions } from "@tanstack/react-query";
import { getSignInProviders, listOAuthProviders } from "./server/oauth-functions.ts";
import { getSignupPolicy, listPendingAccounts } from "./server/signup-functions.ts";

export const oauthProvidersQuery = queryOptions({
  queryKey: ["admin", "oauth"],
  queryFn: () => listOAuthProviders(),
});

export const signupPolicyQuery = queryOptions({
  queryKey: ["admin", "signup-policy"],
  queryFn: () => getSignupPolicy(),
});

export const pendingAccountsQuery = queryOptions({
  queryKey: ["admin", "pending-accounts"],
  queryFn: () => listPendingAccounts(),
});

export const signInProvidersQuery = queryOptions({
  queryKey: ["sign-in-providers"],
  queryFn: () => getSignInProviders(),
});
