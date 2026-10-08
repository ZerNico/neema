import { readDesktopChrome } from "@chat/desktop-rpc";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  currentPushSubscription,
  disablePush,
  enablePush,
  pushSupported,
} from "~/modules/notifications/client/push.ts";
import { pushDevicesQuery } from "~/modules/notifications/client/queries.ts";
import { useNotificationPermission } from "~/modules/notifications/client/use-permission.ts";
import { removePushDevice } from "~/modules/notifications/server/functions.ts";
import { relativeAgeLabel } from "~/modules/chat/ui/timestamps.ts";
import { toastError } from "~/ui/error-toast.ts";
import { ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { Button } from "~/ui/primitives/button";
import { Switch } from "~/ui/primitives/switch";
import { PendingButton } from "~/ui/pending-button.tsx";

/** Where schedule runs reach you. Each schedule decides whether they notify. */
export function NotificationsPage() {
  const inDesktopApp = readDesktopChrome() !== null;
  return (
    <Page
      title="Notifications"
      description="Schedules notify you when a run finishes. Each schedule chooses when."
      rootPath="/settings"
      rootLabel="Settings"
    >
      <Section title={inDesktopApp ? "This app" : "This browser"}>
        <ListCard>
          <OpenRow inDesktopApp={inDesktopApp} />
          {inDesktopApp ? null : <ClosedRow />}
        </ListCard>
      </Section>
      <PushDevices />
    </Page>
  );
}

function OpenRow({ inDesktopApp }: { inDesktopApp: boolean }) {
  const { permission, request } = useNotificationPermission();
  return (
    <ListRow>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">
          {inDesktopApp ? "Desktop notifications" : "While neema is open"}
        </span>
        <span className="text-muted-foreground text-xs">
          {permission === "granted"
            ? inDesktopApp
              ? "On while the app is running, even with its window closed."
              : "On. Turn them off in your browser’s site settings."
            : permission === "denied"
              ? "Blocked. Allow them in your browser’s site settings."
              : permission === "unsupported"
                ? "This browser can’t show notifications."
                : "Off"}
        </span>
      </div>
      {permission === "default" ? (
        <Button size="sm" variant="outline" onClick={() => void request()}>
          Turn on
        </Button>
      ) : null}
    </ListRow>
  );
}

const unsupportedReason = () =>
  !window.isSecureContext
    ? "Needs neema on an https address."
    : /iPhone|iPad/.test(navigator.userAgent)
      ? "Add neema to your Home Screen first, then turn this on there."
      : "This browser can’t receive them while closed.";

function ClosedRow() {
  const queryClient = useQueryClient();
  const supported = pushSupported();
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  useEffect(() => {
    void currentPushSubscription().then((subscription) => setSubscribed(subscription !== null));
  }, []);
  const toggle = useMutation({
    mutationFn: async (on: boolean) => (on ? enablePush() : disablePush().then(() => false)),
    onSuccess: (on) => setSubscribed(on),
    onError: (error) => toastError("Could not change notifications for this browser.", error),
    onSettled: () => queryClient.invalidateQueries({ queryKey: pushDevicesQuery.queryKey }),
  });
  return (
    <ListRow>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">Also when it’s closed</span>
        <span className="text-muted-foreground text-xs">
          {supported ? "Reaches this browser while no neema tab is open." : unsupportedReason()}
        </span>
      </div>
      <Switch
        checked={subscribed === true}
        onCheckedChange={(on) => toggle.mutate(on)}
        disabled={!supported || subscribed === null || toggle.isPending}
        aria-label="Notify this browser when neema is closed"
      />
    </ListRow>
  );
}

function PushDevices() {
  const queryClient = useQueryClient();
  const devices = useQuery(pushDevicesQuery);
  const remove = useMutation({
    mutationFn: (id: string) => removePushDevice({ data: { id } }),
    onError: (error) => toastError("Could not remove that browser.", error),
    onSettled: () => queryClient.invalidateQueries({ queryKey: pushDevicesQuery.queryKey }),
  });
  if (!devices.data?.length) return null;
  return (
    <Section title="Browsers notified while closed">
      <ListCard>
        {devices.data.map((device) => (
          <ListRow key={device.id}>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium">{device.label}</span>
              <span className="text-muted-foreground text-xs">
                {device.lastDeliveredAt
                  ? `Last notified ${relativeAgeLabel(device.lastDeliveredAt)}`
                  : `Added ${relativeAgeLabel(device.createdAt)}`}
              </span>
            </div>
            <PendingButton
              variant="ghost"
              size="sm"
              pending={remove.isPending && remove.variables === device.id}
              onClick={() => remove.mutate(device.id)}
            >
              Remove
            </PendingButton>
          </ListRow>
        ))}
      </ListCard>
    </Section>
  );
}
