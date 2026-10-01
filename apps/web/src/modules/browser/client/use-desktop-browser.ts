import { readDesktopBrowser, type DesktopBrowser } from "@chat/desktop-rpc";
import { useSyncExternalStore } from "react";

const subscribeToNothing = () => () => {};

/** The shell's browser, or null in a web browser and in shells too old to embed one. */
export function useDesktopBrowser(): DesktopBrowser | null {
  return useSyncExternalStore(subscribeToNothing, readDesktopBrowser, () => null);
}
