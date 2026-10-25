import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { notificationPreferencesQuery } from "../client/queries.ts";
import { permissionMissing, useNotificationPermission } from "../client/use-permission.ts";
import { Button } from "~/ui/primitives/button";
import { m } from "~/paraglide/messages.js";

/**
 * Says so when a run's notification would reach nobody: every channel is off,
 * or push is on and this browser may not show it. Asked here, where
 * the person just chose to be told, rather than prompted on its own.
 */
export function NotificationReachHint() {
  const preferences = useQuery(notificationPreferencesQuery).data;
  const { permission, request } = useNotificationPermission();
  if (!preferences) return null;
  const email = preferences.email && preferences.emailAvailable;
  if (!preferences.push && !email)
    return (
      <p className="text-muted-foreground text-sm">
        {m.notifications_hint_off()}{" "}
        <Link to="/settings/notifications" className="underline underline-offset-2">
          {m.notifications_hint_turn_them_on()}
        </Link>
      </p>
    );
  const missing = preferences.push ? permissionMissing(permission) : null;
  if (!missing) return null;
  return (
    <div className="flex items-center gap-2">
      <p className="text-muted-foreground text-sm">
        {`${missing}.`}
        {permission === "denied" ? ` ${m.notifications_hint_allow()}` : null}
      </p>
      {permission === "default" ? (
        <Button type="button" size="xs" variant="outline" onClick={() => void request()}>
          {m.notifications_hint_turn_on()}
        </Button>
      ) : null}
    </div>
  );
}
