import { Schema } from "effect";

/**
 * One thing to tell a person, shown by every channel the same way. The id is
 * the dedupe key: tabs, the service worker and the desktop app use it as the
 * notification tag, so one event shows once per browser.
 */
export const AppNotification = Schema.Struct({
  id: Schema.String,
  title: Schema.String.check(Schema.isMaxLength(200)),
  body: Schema.String.check(Schema.isMaxLength(400)),
  /** Where a click goes, an app path such as `/chat/…`. */
  path: Schema.String.check(Schema.isStartsWith("/")),
});
export type AppNotification = typeof AppNotification.Type;

/** Where schedule runs reach someone; push covers every signed-in device. */
export interface NotificationPreferences {
  push: boolean;
  email: boolean;
  /** False until an admin sets up a mail server. */
  emailAvailable: boolean;
}
