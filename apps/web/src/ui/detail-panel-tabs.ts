/** What survives of one page's panel: titles and order, never the bodies. */
export interface StoredPanelScope {
  tabs: ReadonlyArray<{ id: string; title: string; data?: Readonly<Record<string, string>> }>;
  activeId: string | null;
  visible: boolean;
}

const KEY_PREFIX = "chat.panel-tabs.";
/** Pages remembered per account; the least recently changed are forgotten first. */
export const PANEL_SCOPE_LIMIT = 50;

type Stored = Array<[scope: string, value: StoredPanelScope]>;

const isData = (value: unknown) =>
  value === undefined ||
  (typeof value === "object" &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === "string"));

const isScope = (value: unknown): value is StoredPanelScope => {
  if (typeof value !== "object" || value === null) return false;
  const { tabs, activeId, visible } = value as Record<string, unknown>;
  return (
    Array.isArray(tabs) &&
    tabs.every(
      (tab: unknown) =>
        typeof tab === "object" &&
        tab !== null &&
        typeof (tab as Record<string, unknown>).id === "string" &&
        typeof (tab as Record<string, unknown>).title === "string" &&
        isData((tab as Record<string, unknown>).data),
    ) &&
    (activeId === null || typeof activeId === "string") &&
    typeof visible === "boolean"
  );
};

// Storage is shared by every account that signs in on this browser, so the key
// carries the user: another account must never see these tab titles.
const read = (userId: string): Stored => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY_PREFIX + userId) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is [string, StoredPanelScope] =>
        Array.isArray(entry) && typeof entry[0] === "string" && isScope(entry[1]),
    );
  } catch {
    return [];
  }
};

export function readPanelScope(userId: string, scope: string): StoredPanelScope | null {
  return read(userId).find(([key]) => key === scope)?.[1] ?? null;
}

/** `null` forgets the page. A write moves it to the front of the recency list. */
export function writePanelScope(userId: string, scope: string, value: StoredPanelScope | null) {
  const rest = read(userId).filter(([key]) => key !== scope);
  const next: Stored = value ? [[scope, value], ...rest] : rest;
  try {
    if (next.length === 0) localStorage.removeItem(KEY_PREFIX + userId);
    else
      localStorage.setItem(KEY_PREFIX + userId, JSON.stringify(next.slice(0, PANEL_SCOPE_LIMIT)));
  } catch {
    // A browser refusing storage still has working tabs; they just don't outlive the page.
  }
}
