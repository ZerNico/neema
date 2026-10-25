import { readDesktopChrome } from "@chat/desktop-rpc";
import { useEffect, useState } from "react";
import { ensurePush } from "./push.ts";
import { notificationsSupported } from "./show.ts";
import { m } from "~/paraglide/messages.js";

export type PermissionState = NotificationPermission | "unsupported";

const read = (): PermissionState =>
  notificationsSupported() ? Notification.permission : "unsupported";

/**
 * Why this browser will not show notifications, or null when it will. The
 * desktop app shows them without asking.
 */
export const permissionMissing = (permission: PermissionState) => {
  if (readDesktopChrome() !== null || permission === "granted") return null;
  if (permission === "denied") return m.notifications_permission_denied();
  if (permission === "unsupported") return m.notifications_permission_unsupported();
  return m.notifications_permission_off();
};

/**
 * This browser's notification permission, kept current: the person may change
 * it in site settings while the page is open.
 */
export function useNotificationPermission() {
  const [permission, setPermission] = useState<PermissionState>(read);
  useEffect(() => {
    let status: PermissionStatus | undefined;
    const update = () => setPermission(read());
    void navigator.permissions
      ?.query({ name: "notifications" })
      .then((result) => {
        status = result;
        result.addEventListener("change", update);
      })
      .catch(() => {});
    return () => status?.removeEventListener("change", update);
  }, []);
  const request = async () => {
    if (!notificationsSupported()) return;
    const answer = await Notification.requestPermission();
    setPermission(answer);
    if (answer === "granted") await ensurePush();
  };
  return { permission, request };
}
