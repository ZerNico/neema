import { useSyncExternalStore } from "react";
import type { BrowserLifecycle } from "@chat/desktop-rpc";

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

type TabInput = Pick<BrowserTab, "owner" | "partition" | "url"> & { title?: string };

// Outside React on purpose: a page has to outlive the route, the chat and the
// panel tab that showed it, so only closing its tab (or the app) ends it.
let tabs: ReadonlyMap<string, BrowserTab> = new Map();
const listeners = new Set<() => void>();
const webviews = new Map<string, WebviewElement>();
const placements = new Map<string, Placement>();
const shown = new Set<string>();
const holds = new Map<string, number>();
const temporaryOwners = new Set<string>();

const emit = () => {
  for (const listener of listeners) listener();
};

const commit = (next: Map<string, BrowserTab>) => {
  tabs = next;
  emit();
};

const blank = (id: string, input: TabInput, live: boolean): BrowserTab => ({
  id,
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
};

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

  /** Keeps a chat's pages fully alive until released; counted, so holds nest. */
  hold(owner: string) {
    holds.set(owner, (holds.get(owner) ?? 0) + 1);
    commit(new Map(tabs));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (holds.get(owner) ?? 1) - 1;
      if (count > 0) holds.set(owner, count);
      else holds.delete(owner);
      commit(new Map(tabs));
    };
  },
  held: (): ReadonlySet<string> => new Set(holds.keys()),

  /** Told by the chat view, so a new tab knows which profile and whether to keep it. */
  describe(owner: string, { temporary }: { temporary: boolean }) {
    if (temporary === temporaryOwners.has(owner)) return;
    if (temporary) temporaryOwners.add(owner);
    else temporaryOwners.delete(owner);
    commit(new Map(tabs));
  },
  isTemporary: (owner: string) => temporaryOwners.has(owner),
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
