import { useEffect, useState } from "react";

/** The zooms the buttons step through, as Excel's status bar offers them. */
export const ZOOM_STEPS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2] as const;
const [MIN, MAX] = [ZOOM_STEPS[0], ZOOM_STEPS.at(-1)!];
const KEY = "sheet-zoom";

const clamp = (zoom: number) => Math.min(MAX, Math.max(MIN, Math.round(zoom * 100) / 100));

/** The next step in or out from a zoom, even one a pinch left between steps. */
export function stepZoom(zoom: number, direction: 1 | -1) {
  const next =
    direction === 1
      ? ZOOM_STEPS.find((step) => step > zoom + 0.001)
      : ZOOM_STEPS.toReversed().find((step) => step < zoom - 0.001);
  return next ?? zoom;
}

/**
 * How large this device draws sheets: the same zoom for every sheet, kept on
 * the device, and a pinch on a trackpad over `host` changes it, as Ctrl and
 * the wheel do in Excel. Nobody else's view changes.
 */
export function useSheetZoom(host: HTMLElement | null) {
  const [zoom, setZoom] = useState(() => {
    const kept = typeof window === "undefined" ? NaN : Number(window.localStorage.getItem(KEY));
    return Number.isFinite(kept) && kept > 0 ? clamp(kept) : 1;
  });
  useEffect(() => {
    window.localStorage.setItem(KEY, String(zoom));
  }, [zoom]);
  useEffect(() => {
    if (!host) return;
    // A pinch arrives as a wheel event with Ctrl held; the page itself must not zoom.
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      setZoom((current) => clamp(current * Math.exp(-event.deltaY / 200)));
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, [host]);
  return [zoom, (next: number) => setZoom(clamp(next))] as const;
}
