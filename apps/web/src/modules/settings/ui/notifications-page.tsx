import { readDesktopChrome } from "@chat/desktop-rpc";
import { useNotificationPermission } from "~/modules/notifications/client/use-permission.ts";
import { ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { Button } from "~/ui/primitives/button";

/** Where schedule runs reach you. Each schedule decides whether they notify. */
export function NotificationsPage() {
  const { permission, request } = useNotificationPermission();
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
          <ListRow>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium">
                {inDesktopApp ? "Desktop notifications" : "Notifications while neema is open"}
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
        </ListCard>
      </Section>
    </Page>
  );
}
