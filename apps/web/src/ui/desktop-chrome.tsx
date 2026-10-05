import { readDesktopChrome } from "@chat/desktop-rpc";
import {
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTheme } from "./theme.tsx";
import { ChromeContext } from "./desktop-chrome-context.ts";

const subscribeToNothing = () => () => {};

const TITLEBAR_TARGET = "desktop-titlebar-content";
const PANEL_TARGET = "desktop-titlebar-panel";
const CORNER_TARGET = "desktop-titlebar-corner";

/** The shell owns the frame so hydration and route transitions cannot replace it. */
export function DesktopChromeFrame() {
  return (
    <div className="desktop-titlebar border-border bg-background border-b">
      <div id={TITLEBAR_TARGET} className="desktop-titlebar-content" />
      <div id={PANEL_TARGET} className="desktop-titlebar-panel border-l" />
      <div id={CORNER_TARGET} className="desktop-titlebar-corner" />
    </div>
  );
}

const findTarget = (id: string) => {
  if (typeof document === "undefined") return null;
  const element = document.getElementById(id);
  return element instanceof HTMLDivElement ? element : null;
};

export function DesktopChromeProvider({ children }: { children: ReactNode }) {
  const chrome = useSyncExternalStore(subscribeToNothing, readDesktopChrome, () => null);
  const [target] = useState(() => findTarget(TITLEBAR_TARGET));
  const [panelTarget] = useState(() => findTarget(PANEL_TARGET));
  const [cornerTarget] = useState(() => findTarget(CORNER_TARGET));
  const theme = useTheme();
  const context = useMemo(
    () => ({ chrome, target, panelTarget, cornerTarget }),
    [chrome, target, panelTarget, cornerTarget],
  );

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

/**
 * The detail panel's own header row. On a shell drawing its titlebar it sits at
 * the titlebar's right end, so the panel reads as one column from the top of the
 * window; the stylesheet stops it short of the window controls on Windows/Linux.
 */
export function PanelTitlebar({ children }: { children: ReactNode }) {
  const { chrome, panelTarget } = useContext(ChromeContext);
  if (chrome) {
    return panelTarget
      ? createPortal(
          <div className="desktop-panel-strip flex h-full items-center gap-1 px-2">{children}</div>,
          panelTarget,
        )
      : null;
  }
  return <div className="flex h-12 shrink-0 items-center gap-1 border-b px-2">{children}</div>;
}

/**
 * The top right corner of the app, above whichever of the header or the open
 * detail panel reaches it, so a control placed here never moves when the panel
 * opens or closes. Rows passing under it leave room for it themselves.
 */
export function TitlebarCorner({ children }: { children: ReactNode }) {
  const { chrome, cornerTarget } = useContext(ChromeContext);
  if (chrome) return cornerTarget ? createPortal(children, cornerTarget) : null;
  return <div className="absolute top-0 right-0 z-10 flex h-12 items-center pr-3">{children}</div>;
}
