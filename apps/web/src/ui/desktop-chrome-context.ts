import type { DesktopChrome } from "@chat/desktop-rpc";
import { createContext, useContext } from "react";

export const ChromeContext = createContext<{
  chrome: DesktopChrome | null;
  target: HTMLDivElement | null;
  panelTarget: HTMLDivElement | null;
  cornerTarget: HTMLDivElement | null;
}>({ chrome: null, target: null, panelTarget: null, cornerTarget: null });

/** The shell's platform when it draws its own titlebar, else null. */
export const useDesktopChromePlatform = () => useContext(ChromeContext).chrome?.platform ?? null;
