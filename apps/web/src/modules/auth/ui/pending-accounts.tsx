import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useConfirm } from "~/ui/confirm-context.ts";
import { initials } from "~/ui/initials";
import { ListCard, ListRow, Section } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Avatar, AvatarFallback } from "~/ui/primitives/avatar";
import { Badge } from "~/ui/primitives/badge";
import { decideAccount } from "../server/signup-functions.ts";
import { toastError } from "~/ui/error-toast.ts";
import { m } from "~/paraglide/messages.js";
import { pendingAccountsQuery } from "../queries.ts";

/**
 * Only rendered while somebody is waiting. An empty queue is the ordinary
 * state, and a permanent empty section would be a heading about nothing; the
 * modes that fill this queue are explained where they are set, under Sign-in.
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
    onError: (error) => toastError(m.auth_pending_error(), error),
  });

  if (pending.length === 0) return null;

  return (
    <Section title={m.auth_pending_title()}>
      <ListCard>
        {pending.map((account) => (
          <ListRow key={account.userId}>
            <Avatar className="size-9">
              <AvatarFallback>{initials(account.name)}</AvatarFallback>
            </Avatar>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium">{account.name}</span>
              <span className="text-muted-foreground truncate text-xs">{account.email}</span>
            </div>
            {/* Approving lets them in, not whoever owns the address they typed. */}
            {account.emailVerified ? null : (
              <Badge variant="outline">{m.auth_pending_unverified()}</Badge>
            )}
            <PendingButton
              size="sm"
              variant="outline"
              aria-label={m.auth_pending_decline_label({ name: account.name })}
              pending={decide.isPending}
              onClick={async () => {
                const confirmed = await confirm({
                  title: m.auth_pending_decline_title({ name: account.name }),
                  description: m.auth_pending_decline_description(),
                  confirmLabel: m.auth_pending_decline(),
                });
                if (confirmed) decide.mutate({ userId: account.userId, status: "rejected" });
              }}
            >
              {m.auth_pending_decline()}
            </PendingButton>
            <PendingButton
              size="sm"
              aria-label={m.auth_pending_approve_label({ name: account.name })}
              pending={decide.isPending}
              onClick={() => decide.mutate({ userId: account.userId, status: "approved" })}
            >
              {m.auth_pending_approve()}
            </PendingButton>
          </ListRow>
        ))}
      </ListCard>
    </Section>
  );
}
