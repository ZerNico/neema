/** `Retry-After` as seconds or an HTTP date, in milliseconds; null when absent or unreadable. */
export const parseRetryAfter = (header: string | undefined, now = Date.now()): number | null => {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
};
