import type { BrowserLifecycle } from "@chat/desktop-rpc";

export type TabPlan = BrowserLifecycle | "discarded";

export interface LifecycleTab {
  readonly id: string;
  readonly owner: string;
  /** False once discarded: the page is gone and only its address is kept. */
  readonly live: boolean;
  readonly lastShownAt: number;
  readonly audible: boolean;
}

export interface LifecycleContext {
  readonly now: number;
  /** Tabs on screen right now. */
  readonly visible: ReadonlySet<string>;
  /** Whose pages are on screen (a chat, or a page): they stay at least throttled-alive. */
  readonly onScreen: string | null;
  /** Chats whose answer is running: their tabs stay fully alive. */
  readonly held: ReadonlySet<string>;
}

export const FREEZE_AFTER_MS = 5 * 60_000;
export const LIVE_TAB_CAP = 8;

/**
 * How each tab should run. A shown tab is active, a hidden one throttled, one
 * unseen for a while frozen, and past the cap the least recently shown pages
 * are discarded. A held chat, the chat on screen and a page playing sound are
 * kept from freezing and discarding; holds outrank the cap.
 */
export function planLifecycle(
  tabs: ReadonlyArray<LifecycleTab>,
  context: LifecycleContext,
): Map<string, TabPlan> {
  const plan = new Map<string, TabPlan>();
  const protectedIds = new Set<string>();
  for (const tab of tabs) {
    const visible = context.visible.has(tab.id);
    // A held chat keeps its pages alive, but a discarded one waits for the call
    // that needs it instead of reloading on the hold alone.
    const held = tab.live && context.held.has(tab.owner);
    if (visible || held) {
      plan.set(tab.id, "active");
      protectedIds.add(tab.id);
    } else if (!tab.live) plan.set(tab.id, "discarded");
    else if (tab.audible || tab.owner === context.onScreen) {
      plan.set(tab.id, "background");
      protectedIds.add(tab.id);
    } else
      plan.set(tab.id, context.now - tab.lastShownAt >= FREEZE_AFTER_MS ? "frozen" : "background");
  }
  const live = tabs.filter((tab) => plan.get(tab.id) !== "discarded");
  let excess = live.length - LIVE_TAB_CAP;
  const candidates = live
    .filter((tab) => !protectedIds.has(tab.id))
    .toSorted((a, b) => a.lastShownAt - b.lastShownAt);
  for (const tab of candidates) {
    if (excess <= 0) break;
    plan.set(tab.id, "discarded");
    excess--;
  }
  return plan;
}
