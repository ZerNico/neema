import { SAFE_LINK } from "../../editor/extensions.ts";

/** A bare domain gets https; a scheme the editor would not open is refused. */
export const linkTarget = (raw: string): string | null => {
  const value = raw.trim();
  if (!value) return null;
  if (SAFE_LINK.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  return `https://${value}`;
};

/**
 * Opens a link with Cmd or Ctrl held, since a plain click places the caret;
 * someone who cannot edit opens it with any click. Only web and mail
 * addresses open, always in a new tab.
 */
export const openLink = (editable: boolean, event: MouseEvent) => {
  const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
  const href = link?.getAttribute("href") ?? "";
  if (!link || (editable && !event.metaKey && !event.ctrlKey) || !SAFE_LINK.test(href))
    return false;
  window.open(href, "_blank", "noopener,noreferrer");
  return true;
};
