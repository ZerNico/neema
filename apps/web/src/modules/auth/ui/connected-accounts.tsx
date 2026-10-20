import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { authClient } from "~/modules/auth/client.ts";
import { toastError } from "~/ui/error-toast.ts";
import { ListCard, ListRow, Section } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { FieldError } from "~/ui/primitives/field";
import { oauthErrorMessage } from "../oauth-errors.ts";
import { signInOptionsQuery } from "../queries.ts";

const RETURN_TO = "/settings/profile";

const linkedAccountsQuery = {
  queryKey: ["linked-accounts"],
  queryFn: async () => {
    const { data, error } = await authClient.listAccounts();
    if (error) throw new Error(error.message);
    return data;
  },
};

/**
 * Linking while signed in is the one safe way to join a provider to an
 * existing account: the person proves both. Sign-in itself never merges into
 * an address nobody verified, so this is where those people end up.
 */
export function ConnectedAccounts({ error }: { error?: string | undefined }) {
  const { data: options } = useSuspenseQuery(signInOptionsQuery);
  const { data: accounts } = useQuery(linkedAccountsQuery);
  const queryClient = useQueryClient();
  const [linking, setLinking] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(error ? oauthErrorMessage(error) : null);

  const unlink = useMutation({
    mutationFn: async (input: { providerId: string; accountId: string }) => {
      // Better Auth unlinks by the account row's id alone.
      const { error: refused } = await authClient.unlinkAccount({ accountId: input.accountId });
      if (refused) throw new Error(refused.message ?? "Could not disconnect.");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: linkedAccountsQuery.queryKey }),
    onError: (cause) => toastError("Could not disconnect.", cause),
  });

  if (options.providers.length === 0) return null;

  return (
    <Section title="Connected sign-ins">
      <ListCard>
        {options.providers.map((provider) => {
          const linked = accounts?.find((a) => a.providerId === provider.id);
          return (
            <ListRow key={provider.id}>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{provider.label}</span>
              {linked ? (
                <PendingButton
                  size="sm"
                  variant="outline"
                  pending={unlink.isPending && unlink.variables?.providerId === provider.id}
                  disabled={unlink.isPending}
                  onClick={() => unlink.mutate({ providerId: provider.id, accountId: linked.id })}
                >
                  Disconnect
                </PendingButton>
              ) : (
                <PendingButton
                  size="sm"
                  variant="outline"
                  pending={linking === provider.id}
                  disabled={linking !== null || !accounts}
                  onClick={async () => {
                    setFailure(null);
                    setLinking(provider.id);
                    const { error: refused } = await authClient.linkSocial({
                      provider: provider.id,
                      callbackURL: RETURN_TO,
                      errorCallbackURL: RETURN_TO,
                    });
                    // A success redirects away, so only a failure resumes here.
                    if (refused) {
                      setFailure(refused.message ?? `Could not connect ${provider.label}.`);
                      setLinking(null);
                    }
                  }}
                >
                  Connect
                </PendingButton>
              )}
            </ListRow>
          );
        })}
      </ListCard>
      {failure ? <FieldError>{failure}</FieldError> : null}
    </Section>
  );
}
