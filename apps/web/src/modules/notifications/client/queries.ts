import { queryOptions } from "@tanstack/react-query";
import {
  getNotificationPreferences,
  getSmtpSettings,
  listPushDevices,
} from "../server/functions.ts";

export const pushDevicesQuery = queryOptions({
  queryKey: ["notifications", "push-devices"],
  queryFn: () => listPushDevices(),
});

export const notificationPreferencesQuery = queryOptions({
  queryKey: ["notifications", "preferences"],
  queryFn: () => getNotificationPreferences(),
});

export const smtpSettingsQuery = queryOptions({
  queryKey: ["admin", "smtp"],
  queryFn: () => getSmtpSettings(),
});
