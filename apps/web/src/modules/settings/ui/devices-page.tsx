import { ComputerIcon, GlobeIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  authClient,
  createDesktopTicket,
  desktopSessionsQuery,
  revokeDesktopDevice,
  type DesktopSession,
} from "~/modules/auth/client.ts";
import { hasDesktopMarker } from "~/modules/auth/desktop-ticket.ts";
import { TicketCode } from "~/modules/auth/ui/ticket-code.tsx";
import { useConfirm } from "~/ui/confirm.tsx";
import { FormActions, ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Badge } from "~/ui/primitives/badge";

/** Coarse and forgiving: a wrong guess here costs a label, not access. */
export function describeSession(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad/.test(ua)
        ? "iOS"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Linux|X11/.test(ua)
            ? "Linux"
            : null;
  if (hasDesktopMarker(ua)) return os ? `Chat Desktop on ${os}` : "Chat Desktop";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? (os ? `Browser on ${os}` : "Browser");
}

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
    onError: () => toast.error("Could not sign out the device."),
  });
  const revokeOthers = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.revokeOtherSessions();
      if (error) throw new Error(error.message ?? "Could not sign out other devices.");
    },
    onSuccess: refresh,
    onError: () => toast.error("Could not sign out other devices."),
  });
  const mint = useMutation({ mutationFn: () => createDesktopTicket() });

  const ordered = [...sessions].sort((a, b) => {
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
                      "Every device except this one will have to sign in again, including Chat Desktop.",
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
            const label = describeSession(session.userAgent);
            return (
              <ListRow key={session.id}>
                <HugeiconsIcon
                  icon={hasDesktopMarker(session.userAgent) ? ComputerIcon : GlobeIcon}
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
      <Section
        title="Add a desktop"
        description="Generate a code and paste it into Chat Desktop’s sign-in screen. It works once and only for a few minutes."
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
                  onError: () => toast.error("Could not generate a code."),
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
