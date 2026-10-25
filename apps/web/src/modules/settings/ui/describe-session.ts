import { m } from "~/paraglide/messages.js";
/**
 * Coarse and forgiving: a wrong guess here costs a label, not access. Whether
 * it is the desktop app is the session's own mark, set when a ticket was redeemed.
 */
export function describeSession(userAgent: string | null | undefined, desktop: boolean): string {
  const ua = userAgent ?? "";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad/.test(ua)
        ? "iOS"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Linux|X11/.test(ua)
            ? "Linux"
            : null;
  if (desktop) return os ? m.settings_devices_desktop_on({ os }) : "neema Desktop";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;
  if (browser && os) return m.settings_devices_browser_on({ browser, os });
  return (
    browser ??
    (os ? m.settings_devices_unknown_browser_on({ os }) : m.settings_devices_unknown_browser())
  );
}
