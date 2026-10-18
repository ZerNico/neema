import type { Session } from "electron";
import { toOrigin } from "./config.ts";

// What the app's own pages use: notifications, the clipboard and element fullscreen.
const APP_PERMISSIONS = new Set([
  "notifications",
  "clipboard-read",
  "clipboard-sanitized-write",
  "fullscreen",
]);

/**
 * Whether a page in the app's window may use a permission: one the app uses,
 * asked by the configured server itself. Electron grants every request
 * otherwise, camera, microphone and serial ports included.
 */
export const allowAppPermission = (
  permission: string,
  requestingUrl: string,
  serverOrigin: string | null,
) =>
  APP_PERMISSIONS.has(permission) &&
  serverOrigin !== null &&
  toOrigin(requestingUrl) === serverOrigin;

export const guardWindowPermissions = (session: Session, serverOrigin: () => string | null) => {
  session.setPermissionRequestHandler((_contents, permission, callback, details) =>
    callback(allowAppPermission(permission, details.requestingUrl, serverOrigin())),
  );
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    allowAppPermission(permission, requestingOrigin, serverOrigin()),
  );
};
