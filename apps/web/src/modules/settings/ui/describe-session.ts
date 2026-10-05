import { hasDesktopMarker } from "~/modules/auth/desktop-ticket.ts";

/** Coarse and forgiving: a wrong guess here costs a label, not access. */
export function describeSession(userAgent: string | null | undefined): string {
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
  if (hasDesktopMarker(ua)) return os ? `neema Desktop on ${os}` : "neema Desktop";
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
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? (os ? `Browser on ${os}` : "Browser");
}
