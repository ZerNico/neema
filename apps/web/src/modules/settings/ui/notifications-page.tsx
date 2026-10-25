import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { notificationPreferencesQuery } from "~/modules/notifications/client/queries.ts";
import {
  permissionMissing,
  useNotificationPermission,
} from "~/modules/notifications/client/use-permission.ts";
import type { NotificationPreferences } from "~/modules/notifications/schema.ts";
import { updateNotificationPreferences } from "~/modules/notifications/server/functions.ts";
import { toastError } from "~/ui/error-toast.ts";
import { ErrorState, ListCard, ListRow, ListSkeleton, Page, Section } from "~/ui/page-shell.tsx";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { m } from "~/paraglide/messages.js";

const preferenceChanges = {
  mutationKey: ["notifications", "preferences", "update"],
  exact: true,
};

const channelsLabel = (preferences: NotificationPreferences) =>
  [
    preferences.push && m.settings_notifications_push(),
    preferences.email && preferences.emailAvailable && m.settings_notifications_email(),
  ]
    .filter(Boolean)
    .join(", ") || m.settings_notifications_off();

/** What reaches you, and where. Each schedule still decides when it notifies. */
export function NotificationsPage() {
  const queryClient = useQueryClient();
  const preferencesQuery = useQuery(notificationPreferencesQuery);
  const preferences = preferencesQuery.data;
  const changing = useIsMutating(preferenceChanges) > 0;
  const update = useMutation({
    mutationKey: preferenceChanges.mutationKey,
    mutationFn: (changes: { push?: boolean; email?: boolean }) =>
      updateNotificationPreferences({ data: changes }),
    onMutate: async (changes) => {
      await queryClient.cancelQueries({ queryKey: notificationPreferencesQuery.queryKey });
      const previous = queryClient.getQueryData(notificationPreferencesQuery.queryKey);
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
      toastError(m.settings_notifications_error_save(), error);
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: notificationPreferencesQuery.queryKey }),
  });
  const change = (changes: { push?: boolean; email?: boolean }) => {
    // The shared cache outlives this page and closes the pre-render activation gap.
    if (queryClient.isMutating(preferenceChanges)) return;
    update.mutate(changes);
  };

  return (
    <Page
      title={m.settings_section_notifications()}
      rootPath="/settings"
      rootLabel={m.common_settings()}
    >
      {preferences?.push ? <ThisBrowser /> : null}
      <Section title={m.settings_notifications_about()}>
        {!preferences ? (
          preferencesQuery.isError && !preferencesQuery.isFetching ? (
            <ErrorState
              title={m.settings_notifications_error_load()}
              onRetry={() => void preferencesQuery.refetch()}
            />
          ) : (
            <ListSkeleton rows={1} media="none" label={m.settings_notifications_loading()} />
          )
        ) : (
          <ListCard>
            <ListRow>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">{m.settings_notifications_schedules()}</span>
                <span className="text-muted-foreground text-xs">
                  {m.settings_notifications_schedules_description()}{" "}
                  <Link to="/schedules" className="underline underline-offset-2">
                    {m.settings_notifications_manage_schedules()}
                  </Link>
                </span>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={m.settings_notifications_schedules_label()}
                      disabled={changing}
                      aria-busy={changing || undefined}
                    />
                  }
                >
                  {channelsLabel(preferences)}
                  <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuCheckboxItem
                    checked={preferences.push}
                    disabled={changing}
                    onCheckedChange={(push) => change({ push })}
                  >
                    {m.settings_notifications_push()}
                  </DropdownMenuCheckboxItem>
                  {/* Offered once an admin sets up a mail server. */}
                  {preferences.emailAvailable ? (
                    <DropdownMenuCheckboxItem
                      checked={preferences.email}
                      disabled={changing}
                      onCheckedChange={(email) => change({ email })}
                    >
                      {m.settings_notifications_email()}
                    </DropdownMenuCheckboxItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </ListRow>
          </ListCard>
        )}
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
  const missing = permissionMissing(permission);
  if (!missing) return null;
  return (
    <ListCard>
      <ListRow>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium">{missing}</span>
          {permission === "denied" ? (
            <span className="text-muted-foreground text-xs">
              {m.settings_notifications_denied_hint()}
            </span>
          ) : null}
        </div>
        {permission === "default" ? (
          <Button size="sm" onClick={() => void request()}>
            {m.settings_notifications_turn_on()}
          </Button>
        ) : null}
      </ListRow>
    </ListCard>
  );
}
