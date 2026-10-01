import { siteOf } from "./site-grants.ts";

export interface Driving {
  readonly conversationId: string;
  /** Sites this call may reach besides the chat's own: the one it was allowed to open. */
  readonly allow: ReadonlySet<string>;
}

/**
 * The site a driven page must be stopped from, or null to let it go. Only a
 * page the model is driving is gated; the person's own browsing never is.
 */
export function blockedSite(
  driving: Driving | undefined,
  url: string,
  siteAllowed: (conversationId: string, url: string) => boolean,
): string | null {
  const site = siteOf(url);
  if (!driving || !site) return null;
  return driving.allow.has(site) || siteAllowed(driving.conversationId, url) ? null : site;
}
