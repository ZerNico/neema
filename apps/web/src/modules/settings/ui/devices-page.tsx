import { ComputerIcon, GlobeIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  authClient,
  createDesktopTicket,
  desktopSessionsQuery,
  revokeDesktopDevice,
  type DesktopSession,
} from "~/modules/auth/client.ts";
import { TicketCode } from "~/modules/auth/ui/ticket-code.tsx";
import { useConfirm } from "~/ui/confirm-context.ts";
import { FormActions, ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Badge } from "~/ui/primitives/badge";
import { toastError } from "~/ui/error-toast.ts";
import { describeSession } from "./describe-session.ts";
import { install, useInstallWay, type InstallWay } from "~/ui/install-prompt.ts";
import { Button } from "~/ui/primitives/button";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const when = (value: Date | string) => dateFormat.format(new Date(value));

export function DevicesPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { data: sessions } = useSuspenseQuery(desktopSessionsQuery);
  const refresh = () => queryClient.invalidateQueries({ queryKey: desktopSessionsQuery.queryKey });

  const revoke = useMutation({
    mutationFn: (session: DesktopSession) => revokeDesktopDevice({ id: session.id }),
    onSuccess: refresh,
    onError: (error) => toastError("Could not sign out the device.", error),
  });
  const revokeOthers = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.revokeOtherSessions();
      if (error) throw new Error(error.message ?? "Could not sign out other devices.");
    },
    onSuccess: refresh,
    onError: (error) => toastError("Could not sign out other devices.", error),
  });
  const mint = useMutation({ mutationFn: () => createDesktopTicket() });

  const ordered = [...sessions].toSorted((a, b) => {
    if (a.current) return -1;
    if (b.current) return 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
  const others = sessions.filter((session) => !session.current);

  return (
    <Page title="Devices" rootPath="/settings" rootLabel="Settings">
      <Section
        title="Signed in"
        actions={
          others.length > 0 ? (
            <PendingButton
              variant="outline"
              size="sm"
              pending={revokeOthers.isPending}
              onClick={async () => {
                if (
                  await confirm({
                    title: "Sign out other devices?",
                    description:
                      "Every device except this one will have to sign in again, including neema Desktop.",
                    confirmLabel: "Sign out others",
                  })
                )
                  revokeOthers.mutate();
              }}
            >
              Sign out other devices
            </PendingButton>
          ) : null
        }
      >
        <ListCard>
          {ordered.map((session) => {
            const { current } = session;
            const label = describeSession(session.userAgent, session.desktop);
            return (
              <ListRow key={session.id}>
                <HugeiconsIcon
                  icon={session.desktop ? ComputerIcon : GlobeIcon}
                  strokeWidth={2}
                  className="text-muted-foreground size-5 shrink-0"
                />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{label}</span>
                    {current ? <Badge variant="secondary">This device</Badge> : null}
                  </div>
                  <span className="text-muted-foreground text-xs">
                    Signed in {when(session.createdAt)} · Last active {when(session.updatedAt)}
                  </span>
                </div>
                {current ? null : (
                  <PendingButton
                    variant="ghost"
                    size="sm"
                    pending={revoke.isPending && revoke.variables?.id === session.id}
                    onClick={async () => {
                      if (
                        await confirm({
                          title: `Sign out ${label}?`,
                          description: "That device will have to sign in again.",
                          confirmLabel: "Sign out",
                        })
                      )
                        revoke.mutate(session);
                    }}
                  >
                    Revoke
                  </PendingButton>
                )}
              </ListRow>
            );
          })}
        </ListCard>
      </Section>
      <InstallSection />
      <Section
        title="Add a desktop"
        description="Generate a code and paste it into neema Desktop’s sign-in screen. It works once and only for a few minutes."
      >
        {mint.data ? (
          <TicketCode
            ticket={mint.data.ticket}
            ticketId={mint.data.ticketId}
            expiresAt={mint.data.expiresAt}
            renewing={mint.isPending}
            onRenew={() => mint.mutate()}
          />
        ) : (
          <FormActions>
            <PendingButton
              variant="outline"
              pending={mint.isPending}
              onClick={() =>
                mint.mutate(undefined, {
                  onError: (error) => toastError("Could not generate a code.", error),
                })
              }
            >
              Generate a code
            </PendingButton>
          </FormActions>
        )}
      </Section>
    </Page>
  );
}

/** Safari has no install prompt, so it gets the steps instead. */
const STEPS: Record<Exclude<InstallWay, "prompt" | null>, string> = {
  ios: "In Safari, tap Share, then Add to Home Screen.",
  "mac-safari": "In Safari, choose File, then Add to Dock.",
};

/** Only where this browser can install it now; gone once it is installed. */
function InstallSection() {
  const way = useInstallWay();
  if (!way) return null;
  return (
    <Section
      title="Install on this device"
      description={
        way === "prompt" ? "Opens in its own window, from your dock or home screen." : STEPS[way]
      }
    >
      {way === "prompt" ? (
        <FormActions>
          <Button variant="outline" onClick={() => void install()}>
            Install
          </Button>
        </FormActions>
      ) : null}
    </Section>
  );
}
