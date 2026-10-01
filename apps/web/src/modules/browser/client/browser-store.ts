import { useSyncExternalStore } from "react";
import type { BrowserLifecycle, DesktopBrowser } from "@chat/desktop-rpc";

/** The parts of Electron's `<webview>` element the page uses. */
export interface WebviewElement extends HTMLElement {
  getWebContentsId(): number;
  getURL(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  loadURL(url: string): Promise<void>;
}

export interface BrowserTab {
  readonly id: string;
  /** How the model names the tab within its chat: "t1", "t2", … */
  readonly label: string;
  /** The model call that opened it, so a replayed call finds it instead of opening another. */
  readonly openedBy: string | null;
  /** When the model last asked for it to be shown; the panel follows newer requests. */
  readonly revealAt: number;
  /** The call acting through the tab right now; the page is gated while set. */
  readonly driving: { readonly messageId: string; readonly generationId: string } | null;
  /**
   * The answer that has acted in the tab and is still running, so the panel
   * shows it steadily (and offers Stop) rather than flickering per call.
   */
  readonly usedBy: { readonly messageId: string; readonly generationId: string } | null;
  /** The chat the page belongs to, or `page:<path>` for a page that is not one. */
  readonly owner: string;
  readonly partition: string;
  readonly url: string;
  readonly title: string;
  /** The page's icon as a `data:` URL, once the shell has fetched it. */
  readonly favicon: string | null;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly audible: boolean;
  /** False once discarded: the page is gone and reloads from `url` when shown. */
  readonly live: boolean;
  readonly lastShownAt: number;
  readonly webContentsId: number | null;
  /** What the shell was last told, so the host only sends changes. */
  readonly lifecycle: BrowserLifecycle | null;
}

export interface Placement {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

type TabInput = Pick<BrowserTab, "owner" | "partition" | "url"> & {
  title?: string;
  label?: string;
  openedBy?: string;
};

// Outside React on purpose: a page has to outlive the route, the chat and the
// panel tab that showed it, so only closing its tab (or the app) ends it.
let tabs: ReadonlyMap<string, BrowserTab> = new Map();
const listeners = new Set<() => void>();
const webviews = new Map<string, WebviewElement>();
const placements = new Map<string, Placement>();
// The hovered link's address under each page, laid over it like the page itself.
const statuses = new Map<string, HTMLElement>();
// The frame drawn over a page an answer works in: the page paints over anything
// drawn on its own element, and its box runs to the window's edge.
const frames = new Map<string, HTMLElement>();
const shown = new Set<string>();

/** What the store knows about the chats that own pages, apart from the pages. */
export interface BrowserOwners {
  /** Chats with an answer running on this desktop, whose pages stay fully alive. */
  readonly held: ReadonlySet<string>;
  /** Temporary chats, which browse in memory and keep no tabs. */
  readonly temporary: ReadonlySet<string>;
}
let owners: BrowserOwners = { held: new Set(), temporary: new Set() };

const emit = () => {
  for (const listener of listeners) listener();
};

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((item) => b.has(item));

const commit = (next: Map<string, BrowserTab>) => {
  tabs = next;
  emit();
};

// The next free "t<n>" among a chat's tabs; labels are never reused while a tab holds one.
const nextLabel = (owner: string) => {
  let highest = 0;
  for (const tab of tabs.values())
    if (tab.owner === owner) highest = Math.max(highest, Number(tab.label.slice(1)) || 0);
  return `t${highest + 1}`;
};

const blank = (id: string, input: TabInput, live: boolean): BrowserTab => ({
  id,
  label:
    input.label && !labelTaken(input.owner, input.label) ? input.label : nextLabel(input.owner),
  openedBy: input.openedBy ?? null,
  revealAt: 0,
  driving: null,
  usedBy: null,
  owner: input.owner,
  partition: input.partition,
  url: input.url,
  title: input.title ?? "",
  favicon: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  audible: false,
  live,
  lastShownAt: Date.now(),
  webContentsId: null,
  lifecycle: null,
});

// Geometry is written straight onto the element, never through React: the slot
// follows the panel every animation frame, and a hidden page keeps its last size
// so it does not relayout just for being hidden.
const apply = (id: string) => {
  const element = webviews.get(id);
  if (!element) return;
  const placement = placements.get(id);
  if (placement) {
    element.style.left = `${placement.left}px`;
    element.style.top = `${placement.top}px`;
    element.style.width = `${placement.width}px`;
    element.style.height = `${placement.height}px`;
  }
  const visible = shown.has(id);
  element.style.visibility = visible ? "visible" : "hidden";
  element.style.pointerEvents = visible ? "auto" : "none";
  const frame = frames.get(id);
  if (frame) {
    if (placement) {
      frame.style.left = `${placement.left}px`;
      frame.style.top = `${placement.top}px`;
      frame.style.width = `${placement.width}px`;
      frame.style.height = `${placement.height}px`;
    }
    frame.style.visibility = visible ? "visible" : "hidden";
  }
  const status = statuses.get(id);
  if (!status) return;
  // At the page's bottom left, as a browser shows it, never wider than most of it.
  if (placement) {
    status.style.left = `${placement.left}px`;
    status.style.top = `${placement.top + placement.height}px`;
    status.style.maxWidth = `${Math.round(placement.width * 0.7)}px`;
  }
  status.style.visibility = visible ? "visible" : "hidden";
};

const labelTaken = (owner: string, label: string) =>
  [...tabs.values()].some((tab) => tab.owner === owner && tab.label === label);

export const browserTabs = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  all: () => tabs,
  get: (id: string) => tabs.get(id) ?? null,

  /** A new page, loading at once. */
  open(input: TabInput): BrowserTab {
    const tab = blank(crypto.randomUUID(), input, true);
    commit(new Map(tabs).set(tab.id, tab));
    return tab;
  },
  /** A tab known only from its stored address, as after a restart: discarded until shown. */
  restore(id: string, input: TabInput) {
    if (tabs.has(id)) return;
    commit(new Map(tabs).set(id, blank(id, input, false)));
  },
  update(id: string, patch: Partial<Omit<BrowserTab, "id" | "owner" | "partition">>) {
    const tab = tabs.get(id);
    if (!tab) return;
    const next = { ...tab, ...patch };
    if (Object.entries(patch).every(([key, value]) => tab[key as keyof BrowserTab] === value))
      return;
    commit(new Map(tabs).set(id, next));
  },
  remove(id: string) {
    if (!tabs.has(id)) return;
    const next = new Map(tabs);
    next.delete(id);
    placements.delete(id);
    shown.delete(id);
    commit(next);
  },

  webview: (id: string) => webviews.get(id) ?? null,
  /** The host's element for a tab, or null as it unmounts. */
  attach(id: string, element: WebviewElement | null) {
    if (element) {
      webviews.set(id, element);
      apply(id);
    } else webviews.delete(id);
  },

  /** The element showing a hovered link's address over the page, or null as it goes. */
  attachStatus(id: string, element: HTMLElement | null) {
    if (element) {
      statuses.set(id, element);
      apply(id);
    } else statuses.delete(id);
  },

  /** The frame over a page an answer works in, or null as it goes. */
  attachFrame(id: string, element: HTMLElement | null) {
    if (element) {
      frames.set(id, element);
      apply(id);
    } else frames.delete(id);
  },

  /** Where the tab's slot is, or null when nothing shows it. */
  place(id: string, placement: Placement | null) {
    const was = shown.has(id);
    if (placement) {
      placements.set(id, placement);
      shown.add(id);
    } else shown.delete(id);
    apply(id);
    if (was === shown.has(id)) return;
    // Hiding starts the clock that freezes and then discards an unseen page.
    const tab = tabs.get(id);
    if (tab) commit(new Map(tabs).set(id, { ...tab, lastShownAt: Date.now() }));
    else emit();
  },
  visible: (): ReadonlySet<string> => shown,

  owners: () => owners,
  /** Replaces the chats held because an answer of theirs is running here. */
  setHeld(held: ReadonlySet<string>) {
    if (sameSet(held, owners.held)) return;
    owners = { ...owners, held };
    // A chat whose answer stopped running is no longer using its pages.
    const next = new Map(tabs);
    let changed = false;
    for (const tab of tabs.values())
      if (tab.usedBy && !held.has(tab.owner)) {
        next.set(tab.id, { ...tab, usedBy: null });
        changed = true;
      }
    if (changed) commit(next);
    else emit();
  },
  /**
   * Records whether a chat is temporary, as its view or a call of its answer
   * says, so every new tab of it picks the same profile.
   */
  setTemporary(owner: string, temporary: boolean) {
    if (temporary === owners.temporary.has(owner)) return;
    const next = new Set(owners.temporary);
    if (temporary) next.add(owner);
    else next.delete(owner);
    owners = { ...owners, temporary: next };
    emit();
  },
  /** The profile a new tab of this owner browses in. */
  partitionFor: (
    browser: Pick<DesktopBrowser, "partition" | "temporaryPartition">,
    owner: string,
  ) => (owners.temporary.has(owner) ? browser.temporaryPartition(owner) : browser.partition),
  /** Asks the panel to show the tab, which it does when its chat is on screen. */
  reveal(id: string) {
    const tab = tabs.get(id);
    if (tab) commit(new Map(tabs).set(id, { ...tab, revealAt: Date.now() }));
  },
  /**
   * Resolves once `ready` holds for the current tabs, or with false at the
   * deadline or on abort. Waits on the store, never on a timer loop.
   */
  until(
    ready: (all: ReadonlyMap<string, BrowserTab>) => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (ready(tabs)) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (value: boolean) => {
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener("abort", abort);
        resolve(value);
      };
      const abort = () => finish(false);
      const unsubscribe = browserTabs.subscribe(() => {
        if (ready(tabs)) finish(true);
      });
      const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
      signal?.addEventListener("abort", abort, { once: true });
    });
  },
};

export function useBrowserTab(id: string): BrowserTab | null {
  return useSyncExternalStore(
    browserTabs.subscribe,
    () => browserTabs.get(id),
    () => browserTabs.get(id),
  );
}

export function useBrowserTabs(): ReadonlyMap<string, BrowserTab> {
  return useSyncExternalStore(browserTabs.subscribe, browserTabs.all, browserTabs.all);
}

export function useBrowserOwners(): BrowserOwners {
  return useSyncExternalStore(browserTabs.subscribe, browserTabs.owners, browserTabs.owners);
}
