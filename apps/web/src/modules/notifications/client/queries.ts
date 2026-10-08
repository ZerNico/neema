import { queryOptions } from "@tanstack/react-query";
import { getNotificationPreferences, getSmtpSettings } from "../server/functions.ts";

export const notificationPreferencesQuery = queryOptions({
  queryKey: ["notifications", "preferences"],
  queryFn: () => getNotificationPreferences(),
});

export const smtpSettingsQuery = queryOptions({
  queryKey: ["admin", "smtp"],
  queryFn: () => getSmtpSettings(),
});
