import { queryOptions, useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useConfirm } from "~/ui/confirm.tsx";
import { ListCard, ListRow, Section } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Avatar, AvatarFallback } from "~/ui/primitives/avatar";
import { decideAccount, listPendingAccounts } from "../server/signup-functions.ts";
import { toastError } from "~/ui/error-toast.ts";

export const pendingAccountsQuery = queryOptions({
  queryKey: ["admin", "pending-accounts"],
  queryFn: () => listPendingAccounts(),
});

/**
 * Only rendered while somebody is waiting. An empty queue is the ordinary
 * state, and a permanent empty section would be a heading about nothing; the
 * policy that fills this queue is explained where it is set, under Sign-in.
 */
export function PendingAccounts() {
  const { data: pending } = useSuspenseQuery(pendingAccountsQuery);
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const decide = useMutation({
    mutationFn: (input: { userId: string; status: "approved" | "rejected" }) =>
      decideAccount({ data: input }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin", "pending-accounts"] }),
        queryClient.invalidateQueries({ queryKey: ["admin", "users"] }),
      ]),
    onError: (error) => toastError("Could not decide on the account.", error),
  });

  if (pending.length === 0) return null;

  return (
    <Section title="Waiting for approval">
      <ListCard>
        {pending.map((account) => (
          <ListRow key={account.userId}>
            <Avatar className="size-9">
              <AvatarFallback>{account.name.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium">{account.name}</span>
              <span className="text-muted-foreground truncate text-xs">{account.email}</span>
            </div>
            <PendingButton
              size="sm"
              variant="outline"
              aria-label={`Decline ${account.name}`}
              pending={decide.isPending}
              onClick={async () => {
                const confirmed = await confirm({
                  title: `Decline ${account.name}?`,
                  description:
                    "The account is kept so the same person cannot sign up again and reappear here. They are told an admin declined them.",
                  confirmLabel: "Decline",
                });
                if (confirmed) decide.mutate({ userId: account.userId, status: "rejected" });
              }}
            >
              Decline
            </PendingButton>
            <PendingButton
              size="sm"
              aria-label={`Approve ${account.name}`}
              pending={decide.isPending}
              onClick={() => decide.mutate({ userId: account.userId, status: "approved" })}
            >
              Approve
            </PendingButton>
          </ListRow>
        ))}
      </ListCard>
    </Section>
  );
}
