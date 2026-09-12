import { readDesktopChrome, type DesktopChrome } from "@chat/desktop-rpc";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTheme } from "./theme.tsx";

// Reserve space before hydration; capability detection mirrors readDesktopChrome.
export const desktopChromeInitScript = `(function(){var c=window.__chatDesktop&&window.__chatDesktop.chrome;if(c&&["darwin","win32","linux"].includes(c.platform)&&typeof c.getState==="function"&&typeof c.onState==="function"&&typeof c.setTheme==="function")document.documentElement.dataset.desktopChrome=c.platform})()`;

const subscribeToNothing = () => () => {};
const ChromeContext = createContext<{
  chrome: DesktopChrome | null;
  target: HTMLDivElement | null;
}>({ chrome: null, target: null });

const TITLEBAR_TARGET = "desktop-titlebar-content";

/** The shell owns the frame so hydration and route transitions cannot replace it. */
export function DesktopChromeFrame() {
  return (
    <div className="desktop-titlebar border-border bg-background border-b">
      <div id={TITLEBAR_TARGET} className="desktop-titlebar-content" />
    </div>
  );
}

export function DesktopChromeProvider({ children }: { children: ReactNode }) {
  const chrome = useSyncExternalStore(subscribeToNothing, readDesktopChrome, () => null);
  const [target] = useState(() => {
    if (typeof document === "undefined") return null;
    const element = document.getElementById(TITLEBAR_TARGET);
    return element instanceof HTMLDivElement ? element : null;
  });
  const theme = useTheme();
  const context = useMemo(() => ({ chrome, target }), [chrome, target]);

  useEffect(() => {
    if (!chrome) return;
    const root = document.documentElement;
    root.dataset.desktopChrome = chrome.platform;
    let subscribed = true;
    let receivedEvent = false;
    const update = ({ fullscreen }: { fullscreen: boolean }) => {
      if (subscribed) root.dataset.desktopFullscreen = String(fullscreen);
    };
    const unsubscribe = chrome.onState((state) => {
      receivedEvent = true;
      update(state);
    });
    void chrome
      .getState()
      .then((state) => {
        // A native transition received while the snapshot travelled is newer.
        if (!receivedEvent) update(state);
      })
      .catch((error) => console.error("Could not read window appearance", error));
    return () => {
      subscribed = false;
      unsubscribe();
      // Platform geometry belongs to the document, not this subscription.
      delete root.dataset.desktopFullscreen;
    };
  }, [chrome]);

  useEffect(() => {
    if (!chrome) return;
    void chrome
      .setTheme(theme)
      .catch((error) => console.error("Could not update window appearance", error));
  }, [chrome, theme]);

  return <ChromeContext value={context}>{children}</ChromeContext>;
}

/** The portal keeps sidebar and Work contexts without moving their providers. */
export function AppHeader({ children }: { children: ReactNode }) {
  const { chrome, target } = useContext(ChromeContext);
  if (chrome) {
    return target
      ? createPortal(
          <header className="desktop-header flex h-full items-center gap-2 px-3">
            {children}
          </header>,
          target,
        )
      : null;
  }
  return (
    <header className="border-border flex h-12 shrink-0 items-center gap-2 border-b px-3">
      {children}
    </header>
  );
}
