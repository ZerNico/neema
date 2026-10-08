import { useEffect, useState } from "react";
import { ensurePush } from "./push.ts";
import { notificationsSupported } from "./show.ts";

export type PermissionState = NotificationPermission | "unsupported";

const read = (): PermissionState =>
  notificationsSupported() ? Notification.permission : "unsupported";

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
