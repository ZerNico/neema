import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRouterState } from "@tanstack/react-router";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "~/ui/primitives/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "~/ui/primitives/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { useIsMobile } from "~/ui/use-mobile";
import { cn } from "~/ui/utils";

export interface DetailPanelRequest {
  /** Identity of the content. Refreshing the same id preserves body state. */
  id: string;
  title: string;
  /** Snapshotted like the body; live owners refresh both after committing data. */
  subtitle?: ReactNode;
  /** Props are snapshotted at open time, then updated by re-open or refresh. */
  body: ReactNode;
}

export interface DetailPanelApi {
  open: (request: DetailPanelRequest) => void;
  close: () => void;
  /** Update only the currently selected identity; never open or switch a panel. */
  refresh: (request: DetailPanelRequest) => void;
  closeIfSelected: (id: string) => void;
}

// Actions are split from state so that opening or closing the panel doesn't
// re-render every consumer that only ever calls open() — i.e. every message.
const DetailPanelContext = createContext<DetailPanelApi | null>(null);
const DetailPanelStateContext = createContext<DetailPanelRequest | null>(null);
// Live owners subscribe to identity, not the request they refresh: updating a
// body must not trigger another owner render and refresh feedback loop.
const DetailPanelSelectedIdContext = createContext<string | null>(null);

// A general-purpose detail region beside the main content — the sources list is
// the first tenant, not the only intended one.
//
//   const panel = useDetailPanel()
//   panel.open({ id: `sources:${messageId}`, title: "Sources",
//                body: <SourcesPanelBody … /> })
//
// The provider only supplies context; render <DetailPanelRail /> wherever the
// region belongs in the layout. On desktop the rail is a flex *sibling* of the
// content, so opening it shrinks the content rather than covering it; on mobile
// it becomes a bottom sheet.
export function DetailPanelProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DetailPanelRequest | null>(null);

  const open = useCallback((request: DetailPanelRequest) => setState(request), []);
  const close = useCallback(() => setState(null), []);
  const refresh = useCallback((request: DetailPanelRequest) => {
    setState((current) => (current?.id === request.id ? request : current));
  }, []);
  const closeIfSelected = useCallback((id: string) => {
    setState((current) => (current?.id === id ? null : current));
  }, []);

  // Otherwise navigating away leaves the panel showing the previous page's
  // detail. Derived during render — no effect needed.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [lastPathname, setLastPathname] = useState(pathname);
  if (lastPathname !== pathname) {
    setLastPathname(pathname);
    setState(null);
  }

  const api = useMemo<DetailPanelApi>(
    () => ({ open, close, refresh, closeIfSelected }),
    [open, close, refresh, closeIfSelected],
  );

  return (
    <DetailPanelContext.Provider value={api}>
      <DetailPanelSelectedIdContext.Provider value={state?.id ?? null}>
        <DetailPanelStateContext.Provider value={state}>
          {children}
        </DetailPanelStateContext.Provider>
      </DetailPanelSelectedIdContext.Provider>
    </DetailPanelContext.Provider>
  );
}

export function DetailPanelRail({ className }: { className?: string }) {
  const state = useContext(DetailPanelStateContext);
  const panel = useDetailPanel();
  const isMobile = useIsMobile();
  const openOnDesktop = state !== null && !isMobile;

  // The rail isn't a dialog (it doesn't trap focus or block the page), so
  // Escape-to-close is ours to wire. The mobile sheet handles its own.
  useEffect(() => {
    if (!openOnDesktop) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") panel.close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openOnDesktop, panel]);

  if (state === null) return null;

  if (isMobile) {
    return (
      <Sheet open onOpenChange={(open) => !open && panel.close()}>
        <SheetContent side="bottom" className="max-h-[80svh]">
          <SheetHeader className="pb-2">
            <SheetTitle>{state.title}</SheetTitle>
            {state.subtitle ? (
              <p className="text-muted-foreground text-xs">{state.subtitle}</p>
            ) : null}
          </SheetHeader>
          <div key={state.id} className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
            {state.body}
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <aside
      aria-label={state.title}
      className={cn("flex w-[22rem] shrink-0 flex-col overflow-hidden border-l", className)}
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{state.title}</p>
        {state.subtitle ? (
          <span className="text-muted-foreground shrink-0 text-xs">{state.subtitle}</span>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={panel.close}
                aria-label="Close panel"
                className="text-muted-foreground"
              />
            }
          >
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
          </TooltipTrigger>
          <TooltipContent>Close panel</TooltipContent>
        </Tooltip>
      </div>
      <div key={state.id} className="min-h-0 flex-1 overflow-y-auto p-4">
        {state.body}
      </div>
    </aside>
  );
}

/** Stable actions — safe to depend on from memo hooks. */
export function useDetailPanel(): DetailPanelApi {
  const api = useContext(DetailPanelContext);
  if (!api) throw new Error("useDetailPanel must be used within a DetailPanelProvider");
  return api;
}

/** Selection-only subscription: body/subtitle refreshes do not notify owners. */
export function useDetailPanelSelectedId(): string | null {
  return useContext(DetailPanelSelectedIdContext);
}
