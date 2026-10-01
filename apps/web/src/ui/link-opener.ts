/**
 * Where web links open when not in the computer's browser. Its own module,
 * apart from the dialog that reads it, so editing the dialog in development
 * does not reset what the desktop app's browser registered.
 */
type LinkOpener = (url: string) => void;
let panel: { open: LinkOpener; byDefault: boolean } | null = null;
// ⌘ or Ctrl held on the last click, for a link that opens after its click
// (rendered markdown asks first); stale after a moment.
let modifiedAt = 0;
const MODIFIER_FRESH_MS = 1_000;

/**
 * Set by the desktop app's browser while it can show web links in its side
 * panel (`browser/ui/browser-host.tsx`), and whether that is the default.
 */
export function setLinkOpener(opener: { open: LinkOpener; byDefault: boolean } | null) {
  panel = opener;
}

/** Records whether ⌘ or Ctrl was held on a click, which asks for the other place. */
export function noteLinkClick(modified: boolean) {
  modifiedAt = modified ? Date.now() : 0;
}

/** Whether a link opening now goes to the side panel: the default, unless ⌘ or Ctrl said otherwise. */
export function linkGoesToPanel(): boolean {
  if (!panel) return false;
  return panel.byDefault !== Date.now() - modifiedAt < MODIFIER_FRESH_MS;
}

/** Opens a web link in the side panel when it goes there; false otherwise. */
export function openLinkInPanel(url: string): boolean {
  if (!panel || !linkGoesToPanel()) return false;
  panel.open(url);
  return true;
}
