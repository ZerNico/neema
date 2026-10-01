import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  LinkSquare02Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useLayoutEffect, useRef, useState } from "react";
import { useDetailPanel, type DetailPanelRequest } from "~/ui/detail-panel.tsx";
import { Button } from "~/ui/primitives/button";
import { Input } from "~/ui/primitives/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { hostOf, toAddress } from "../client/address.ts";
import { browserTabs, useBrowserTab, type BrowserTab } from "../client/browser-store.ts";
import { useSearchEngine } from "../client/search-engine.ts";
import { useBrowserOwner } from "../client/owner.ts";
import { useDesktopBrowser } from "../client/use-desktop-browser.ts";
import { useSettledLoading } from "../client/use-settled-loading.ts";

/**
 * Where the page shows. The page itself lives in the host's layer and is laid
 * over this box, so the box reports its rectangle: on resize, and every frame
 * until it has held still a while, which covers the panel opening, the phone
 * overlay sliding in and the rail being dragged.
 */
export function BrowserSlot({ id }: { id: string }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    let frame = 0;
    let still = 0;
    let last = "";
    const measure = () => {
      const { left, top, width, height } = element.getBoundingClientRect();
      const key = `${left},${top},${width},${height}`;
      if (key === last) {
        still++;
        return;
      }
      last = key;
      still = 0;
      browserTabs.place(id, { left, top, width, height });
    };
    const settle = () => {
      cancelAnimationFrame(frame);
      still = 0;
      const step = () => {
        measure();
        if (still < 12) frame = requestAnimationFrame(step);
      };
      step();
    };
    settle();
    const observer = new ResizeObserver(settle);
    observer.observe(element);
    window.addEventListener("resize", settle);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", settle);
      browserTabs.place(id, null);
    };
  }, [id]);
  return <div ref={box} className="min-h-0 flex-1" />;
}

function ChromeButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: IconSvgElement;
  /** Absent leaves the button disabled, as on a page with no history yet. */
  onClick: (() => void) | undefined;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClick}
            disabled={!onClick}
            aria-label={label}
            className="text-muted-foreground"
          />
        }
      >
        <HugeiconsIcon icon={icon} strokeWidth={2} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** The row above a page, and above a new tab, which looks the same before it has one. */
function AddressBar({
  url,
  loading,
  autoFocus = false,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onStop,
  onOpenExternal,
}: {
  url: string;
  loading: boolean;
  autoFocus?: boolean;
  onNavigate: (url: string) => void;
  onBack?: (() => void) | undefined;
  onForward?: (() => void) | undefined;
  onReload?: (() => void) | undefined;
  onStop?: (() => void) | undefined;
  onOpenExternal?: (() => void) | undefined;
}) {
  const { engine } = useSearchEngine();
  const settledLoading = useSettledLoading(loading);
  // What is being typed; null shows the page's own address as it changes.
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (draft === null || draft.trim() === "") return;
        setDraft(null);
        onNavigate(toAddress(draft, engine));
        event.currentTarget.querySelector("input")?.blur();
      }}
    >
      <ChromeButton label="Back" icon={ArrowLeft01Icon} onClick={onBack} />
      <ChromeButton label="Forward" icon={ArrowRight01Icon} onClick={onForward} />
      {settledLoading ? (
        <ChromeButton label="Stop" icon={Cancel01Icon} onClick={onStop} />
      ) : (
        <ChromeButton label="Reload" icon={RefreshIcon} onClick={onReload} />
      )}
      <Input
        aria-label="Address"
        placeholder="Search or enter an address"
        value={draft ?? url}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={() => setDraft(null)}
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- a new tab exists to be typed into
        autoFocus={autoFocus}
        spellCheck={false}
        autoComplete="off"
      />
      <ChromeButton label="Open in browser" icon={LinkSquare02Icon} onClick={onOpenExternal} />
    </form>
  );
}

export function BrowserChrome({ id }: { id: string }) {
  const tab = useBrowserTab(id);
  const browser = useDesktopBrowser();
  if (!tab) return null;
  const webview = () => browserTabs.webview(id);
  return (
    <AddressBar
      url={tab.url}
      loading={tab.loading}
      onNavigate={(url) => {
        const element = webview();
        if (element) void element.loadURL(url).catch(() => {});
        else browserTabs.update(id, { url });
      }}
      onBack={tab.canGoBack ? () => webview()?.goBack() : undefined}
      onForward={tab.canGoForward ? () => webview()?.goForward() : undefined}
      onReload={() => webview()?.reload()}
      onStop={() => webview()?.stop()}
      onOpenExternal={
        browser && hostOf(tab.url) !== null
          ? () => void browser.openExternal(tab.url).catch(() => {})
          : undefined
      }
    />
  );
}

/**
 * A new tab's address bar, the same row a page has. Submitting turns the tab
 * into that page in place, owned by the chat or page on screen.
 */
export function NewTabBar({
  tabId,
  toRequest,
}: {
  tabId: string;
  /** How a page becomes a tab; passed in, since that module renders this one. */
  toRequest: (tab: BrowserTab, restorable: boolean) => DetailPanelRequest;
}) {
  const browser = useDesktopBrowser();
  const panel = useDetailPanel();
  const owner = useBrowserOwner();
  if (!browser) return null;
  return (
    <AddressBar
      url=""
      loading={false}
      autoFocus
      onNavigate={(url) => {
        const temporary = browserTabs.isTemporary(owner);
        const tab = browserTabs.open({
          owner,
          partition: temporary ? browser.temporaryPartition(owner) : browser.partition,
          url,
        });
        panel.replaceTab(tabId, toRequest(tab, !temporary));
      }}
    />
  );
}
