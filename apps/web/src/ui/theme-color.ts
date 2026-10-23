import { useEffect } from "react";

/** As a hex, since not every browser reads `oklch()` in a theme colour. */
function toHex(color: string) {
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The installed app's title bar and a phone's status bar take the colour at
 * the top of the page: the sidebar canvas around an inset sheet, which only
 * has its margin from `md` up, else the sheet.
 */
function topColor(wide: boolean) {
  const root = document.documentElement;
  const token = wide && root.dataset.sidebarVariant === "inset" ? "--sidebar" : "--background";
  return toHex(getComputedStyle(root).getPropertyValue(token).trim());
}

/** Keeps the head's `theme-color` in step with the theme, scheme and layout. */
export function useThemeColor() {
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 48rem)");
    const update = () => {
      const color = topColor(wide.matches);
      if (!color) return;
      const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
      if (meta) meta.content = color;
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributeFilter: ["class", "data-scheme", "data-sidebar-variant"],
    });
    wide.addEventListener("change", update);
    return () => {
      observer.disconnect();
      wide.removeEventListener("change", update);
    };
  }, []);
}
