import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  LinkSquare02Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useMutation } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { stopGeneration } from "~/modules/chat/server/functions.ts";
import { m } from "~/paraglide/messages.js";
import { toastError } from "~/ui/error-toast.ts";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Spinner } from "~/ui/primitives/spinner";
import { type DetailPanelRequest } from "~/ui/detail-panel.tsx";
import { useDetailPanel } from "~/ui/detail-panel-context.ts";
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
 * until it has held still a while. The rail opening or closing moves the box
 * without resizing it, so its animation, which rewrites the rail's style every
 * frame, starts the same tracking.
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
    const rail = element.closest("[data-panel-rail]");
    const animated = new MutationObserver(settle);
    if (rail) animated.observe(rail, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("resize", settle);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      animated.disconnect();
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
      <ChromeButton label={m.common_back()} icon={ArrowLeft01Icon} onClick={onBack} />
      <ChromeButton label={m.common_forward()} icon={ArrowRight01Icon} onClick={onForward} />
      {settledLoading ? (
        <ChromeButton
          label={m.browser_chrome_stop_loading()}
          icon={Cancel01Icon}
          onClick={onStop}
        />
      ) : (
        <ChromeButton label={m.common_reload()} icon={RefreshIcon} onClick={onReload} />
      )}
      <Input
        aria-label={m.browser_chrome_address()}
        placeholder={m.browser_chrome_address_placeholder()}
        value={draft ?? url}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={() => setDraft(null)}
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- a new tab exists to be typed into
        autoFocus={autoFocus}
        spellCheck={false}
        autoComplete="off"
      />
      <ChromeButton
        label={m.browser_chrome_open_external()}
        icon={LinkSquare02Icon}
        onClick={onOpenExternal}
      />
    </form>
  );
}

/**
 * Says the answer is working in this tab, and stops it: the composer's Stop,
 * from here. It stands in for the address row at the same height, for as long
 * as the answer runs, so the page below never moves.
 */
function DrivingNote({
  conversationId,
  driving,
  url,
}: {
  conversationId: string;
  driving: { messageId: string; generationId: string };
  url: string;
}) {
  const stop = useMutation({
    mutationFn: () => stopGeneration({ data: { conversationId, ...driving } }),
    onError: (error) => toastError(m.browser_driving_stop_error(), error),
  });
  const host = hostOf(url);
  return (
    <div className="text-muted-foreground flex h-8 items-center gap-2 px-2 text-sm" role="status">
      <Spinner aria-hidden className="size-3.5" />
      <span className="min-w-0 flex-1 truncate">
        {host ? m.browser_driving_on_host({ host }) : m.browser_driving_in_tab()}
      </span>
      <PendingButton
        size="xs"
        variant="outline"
        pending={stop.isPending}
        onClick={() => stop.mutate()}
      >
        {m.browser_driving_stop()}
      </PendingButton>
    </div>
  );
}

export function BrowserChrome({ id }: { id: string }) {
  const tab = useBrowserTab(id);
  const browser = useDesktopBrowser();
  if (!tab) return null;
  const webview = () => browserTabs.webview(id);
  return tab.usedBy ? (
    <DrivingNote conversationId={tab.owner} driving={tab.usedBy} url={tab.url} />
  ) : (
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
  toRequest: (tab: BrowserTab) => DetailPanelRequest;
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
        const tab = browserTabs.open({
          owner,
          partition: browserTabs.partitionFor(browser, owner),
          url,
        });
        panel.replaceTab(tabId, toRequest(tab));
      }}
    />
  );
}
