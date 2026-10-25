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
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";

const when = (value: Date | string) =>
  new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );

export function DevicesPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { data: sessions } = useSuspenseQuery(desktopSessionsQuery);
  const refresh = () => queryClient.invalidateQueries({ queryKey: desktopSessionsQuery.queryKey });

  const revoke = useMutation({
    mutationFn: (session: DesktopSession) => revokeDesktopDevice({ id: session.id }),
    onSuccess: refresh,
    onError: (error) => toastError(m.settings_devices_error_revoke(), error),
  });
  const revokeOthers = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.revokeOtherSessions();
      if (error) throw new Error(error.message ?? m.settings_devices_error_revoke_others());
    },
    onSuccess: refresh,
    onError: (error) => toastError(m.settings_devices_error_revoke_others(), error),
  });
  const mint = useMutation({ mutationFn: () => createDesktopTicket() });

  const ordered = [...sessions].toSorted((a, b) => {
    if (a.current) return -1;
    if (b.current) return 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
  const others = sessions.filter((session) => !session.current);

  return (
    <Page title={m.settings_section_devices()} rootPath="/settings" rootLabel={m.common_settings()}>
      <Section
        title={m.settings_devices_signed_in()}
        actions={
          others.length > 0 ? (
            <PendingButton
              variant="outline"
              size="sm"
              pending={revokeOthers.isPending}
              onClick={async () => {
                if (
                  await confirm({
                    title: m.settings_devices_revoke_others_title(),
                    description: m.settings_devices_revoke_others_description(),
                    confirmLabel: m.settings_devices_revoke_others_confirm(),
                  })
                )
                  revokeOthers.mutate();
              }}
            >
              {m.settings_devices_revoke_others()}
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
                    {current ? (
                      <Badge variant="secondary">{m.settings_devices_this_device()}</Badge>
                    ) : null}
                  </div>
                  <span className="text-muted-foreground text-xs">
                    {m.settings_devices_session_times({
                      signedIn: when(session.createdAt),
                      active: when(session.updatedAt),
                    })}
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
                          title: m.settings_devices_revoke_title({ name: label }),
                          description: m.settings_devices_revoke_description(),
                          confirmLabel: m.settings_devices_revoke_confirm(),
                        })
                      )
                        revoke.mutate(session);
                    }}
                  >
                    {m.settings_devices_revoke()}
                  </PendingButton>
                )}
              </ListRow>
            );
          })}
        </ListCard>
      </Section>
      <InstallSection />
      <Section
        title={m.settings_devices_add_desktop_title()}
        description={m.settings_devices_add_desktop_description()}
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
                  onError: (error) => toastError(m.settings_devices_error_code(), error),
                })
              }
            >
              {m.settings_devices_generate_code()}
            </PendingButton>
          </FormActions>
        )}
      </Section>
    </Page>
  );
}

/** Safari has no install prompt, so it gets the steps instead. */
const STEPS: Record<Exclude<InstallWay, "prompt" | null>, () => string> = {
  ios: m.settings_devices_install_ios,
  "mac-safari": m.settings_devices_install_mac_safari,
};

/** Only where this browser can install it now; gone once it is installed. */
function InstallSection() {
  const way = useInstallWay();
  if (!way) return null;
  return (
    <Section
      title={m.settings_devices_install_title()}
      description={way === "prompt" ? m.settings_devices_install_description() : STEPS[way]()}
    >
      {way === "prompt" ? (
        <FormActions>
          <Button variant="outline" onClick={() => void install()}>
            {m.settings_devices_install()}
          </Button>
        </FormActions>
      ) : null}
    </Section>
  );
}
