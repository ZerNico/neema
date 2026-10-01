import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "chat.detail-panel-width";
/** Below this the header row and a Markdown line stop being readable. */
export const DETAIL_PANEL_MIN = 320;
/** Keyboard resizing moves in this step, so arrows stay predictable. */
export const DETAIL_PANEL_STEP = 24;

/**
 * The rail may never take more than half the window, so the conversation it
 * belongs to keeps at least as much room as the detail about it.
 */
export const detailPanelMax = (viewport: number) =>
  Math.max(DETAIL_PANEL_MIN, Math.min(704, Math.round(viewport / 2)));

export const clampDetailPanelWidth = (width: number, viewport: number) =>
  Math.min(Math.max(Math.round(width), DETAIL_PANEL_MIN), detailPanelMax(viewport));

/**
 * Until someone drags the rail, its width is a share of the window, so a large
 * screen opens it roomier than a laptop does. A dragged width is kept as is.
 */
export const defaultDetailPanelWidth = (viewport: number) =>
  clampDetailPanelWidth(viewport * 0.38, viewport);

const listeners = new Set<() => void>();
let override: number | null = null;

const read = (): number => {
  if (override !== null) return override;
  const stored = Number(localStorage.getItem(STORAGE_KEY));
  if (!Number.isFinite(stored) || stored <= 0) return defaultDetailPanelWidth(window.innerWidth);
  return clampDetailPanelWidth(stored, window.innerWidth);
};

const emit = () => {
  for (const listener of listeners) listener();
};

/**
 * Held outside React while a drag is in flight: the rail follows the pointer on
 * every move, and writing each of those to storage would be a write per frame.
 */
export function setDetailPanelWidth(width: number, persist: boolean) {
  override = width;
  if (persist) {
    override = null;
    try {
      localStorage.setItem(STORAGE_KEY, String(width));
    } catch {
      // A browser refusing storage should still resize for this session.
      override = width;
    }
  }
  emit();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      override = null;
      emit();
    }
  };
  window.addEventListener("storage", onStorage);
  const onResize = () => emit();
  window.addEventListener("resize", onResize);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("resize", onResize);
  };
};

export function useDetailPanelWidth() {
  // Client-only: the panel mounts below the app's client boundary.
  const width = useSyncExternalStore(subscribe, read, read);
  const resize = useCallback((next: number, persist = true) => {
    setDetailPanelWidth(clampDetailPanelWidth(next, window.innerWidth), persist);
  }, []);
  const reset = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignored: the clamped default below is what matters.
    }
    override = null;
    emit();
  }, []);
  return { width, resize, reset };
}
