import { readDesktopChrome } from "@chat/desktop-rpc";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { notificationPreferencesQuery } from "~/modules/notifications/client/queries.ts";
import { useNotificationPermission } from "~/modules/notifications/client/use-permission.ts";
import type { NotificationPreferences } from "~/modules/notifications/schema.ts";
import { updateNotificationPreferences } from "~/modules/notifications/server/functions.ts";
import { toastError } from "~/ui/error-toast.ts";
import { ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";

const channelsLabel = (preferences: NotificationPreferences) =>
  [preferences.push && "Push", preferences.email && preferences.emailAvailable && "Email"]
    .filter(Boolean)
    .join(", ") || "Off";

/** What reaches you, and where. Each schedule still decides when it notifies. */
export function NotificationsPage() {
  const queryClient = useQueryClient();
  const { data: preferences } = useQuery(notificationPreferencesQuery);
  const update = useMutation({
    mutationFn: (changes: { push?: boolean; email?: boolean }) =>
      updateNotificationPreferences({ data: changes }),
    onMutate: (changes) => {
      const previous = preferences;
      if (previous)
        queryClient.setQueryData(notificationPreferencesQuery.queryKey, {
          ...previous,
          ...changes,
        });
      return { previous };
    },
    onError: (error, _changes, context) => {
      if (context?.previous)
        queryClient.setQueryData(notificationPreferencesQuery.queryKey, context.previous);
      toastError("Could not change notifications.", error);
    },
  });

  return (
    <Page title="Notifications" rootPath="/settings" rootLabel="Settings">
      {preferences?.push ? <ThisBrowser /> : null}
      <Section title="Notify me about">
        <ListCard>
          <ListRow>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium">Schedules</span>
              <span className="text-muted-foreground text-xs">
                When a run finishes, or its answer finds something worth telling you.{" "}
                <Link to="/schedules" className="underline underline-offset-2">
                  Manage schedules
                </Link>
              </span>
            </div>
            {preferences ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button variant="outline" size="sm" aria-label="Schedule notifications" />
                  }
                >
                  {channelsLabel(preferences)}
                  <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuCheckboxItem
                    checked={preferences.push}
                    onCheckedChange={(push) => update.mutate({ push })}
                  >
                    Push
                  </DropdownMenuCheckboxItem>
                  {/* Offered once an admin sets up a mail server. */}
                  {preferences.emailAvailable ? (
                    <DropdownMenuCheckboxItem
                      checked={preferences.email}
                      onCheckedChange={(email) => update.mutate({ email })}
                    >
                      Email
                    </DropdownMenuCheckboxItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </ListRow>
        </ListCard>
      </Section>
    </Page>
  );
}

/**
 * Push needs this browser's permission, which only it can give. Said only
 * when something is missing; the desktop app never needs it.
 */
function ThisBrowser() {
  const { permission, request } = useNotificationPermission();
  if (readDesktopChrome() !== null || permission === "granted") return null;
  return (
    <ListCard>
      <ListRow>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium">
            {permission === "denied"
              ? "Notifications are blocked in this browser"
              : permission === "unsupported"
                ? "This browser can’t show notifications"
                : "Notifications are off in this browser"}
          </span>
          {permission === "denied" ? (
            <span className="text-muted-foreground text-xs">Allow them in its site settings.</span>
          ) : null}
        </div>
        {permission === "default" ? (
          <Button size="sm" onClick={() => void request()}>
            Turn on
          </Button>
        ) : null}
      </ListRow>
    </ListCard>
  );
}
