import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { notificationPreferencesQuery } from "../client/queries.ts";
import { permissionMissing, useNotificationPermission } from "../client/use-permission.ts";
import { Button } from "~/ui/primitives/button";

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
        Your notifications are off.{" "}
        <Link to="/settings/notifications" className="underline underline-offset-2">
          Turn them on
        </Link>
      </p>
    );
  const missing = preferences.push ? permissionMissing(permission) : null;
  if (!missing) return null;
  return (
    <div className="flex items-center gap-2">
      <p className="text-muted-foreground text-sm">
        {missing}.{permission === "denied" ? " Allow them in its site settings." : null}
      </p>
      {permission === "default" ? (
        <Button type="button" size="xs" variant="outline" onClick={() => void request()}>
          Turn on
        </Button>
      ) : null}
    </div>
  );
}
