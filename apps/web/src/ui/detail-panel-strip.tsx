import { Cancel01Icon, File01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { RestrictToHorizontalAxis } from "@dnd-kit/abstract/modifiers";
import { RestrictToElement } from "@dnd-kit/dom/modifiers";
import { DragDropProvider, PointerSensor } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import type { DetailPanelApi, DetailPanelTabSummary } from "~/ui/detail-panel-state.ts";
import { useAppReducedMotion } from "~/ui/reduced-motion.ts";
import { Button } from "~/ui/primitives/button";
import { Spinner } from "~/ui/primitives/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { cn } from "~/ui/utils";
import { m } from "~/paraglide/messages.js";

// dnd-kit will not start a drag from a button inside the dragged element, and a
// tab is mostly its button. Only the close button keeps a press to itself.
const TAB_SENSORS = [
  PointerSensor.configure({
    preventActivation: (event) =>
      event.target instanceof Element && event.target.closest("[data-tab-close]") !== null,
  }),
];

// Along the strip only, and never past either end of the tab list.
const TAB_MODIFIERS = [
  RestrictToHorizontalAxis,
  RestrictToElement.configure({
    element: (operation) => operation.source?.element?.closest("[role=tablist]") ?? null,
  }),
];

/**
 * One button per tab, with roving focus: Tab enters on the selected one, arrows
 * move and select, Alt+Shift+arrows move the tab itself. Dragging sorts with
 * dnd-kit, whose other tabs slide aside as one passes them; its keyboard sensor
 * is left out because it would take Enter and Space, which select a tab.
 */
export function DetailPanelTabStrip({
  panel,
  view: { tabs, activeId, visible },
  ids,
}: {
  panel: DetailPanelApi;
  view: {
    tabs: ReadonlyArray<DetailPanelTabSummary>;
    activeId: string | null;
    visible: boolean;
  };
  ids: { tab: (index: number) => string; panel: string };
}) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const tab = tabs[index];
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (tab && step !== 0 && event.altKey && event.shiftKey) {
      event.preventDefault();
      panel.moveTab(tab.id, index + step);
      return;
    }
    const target =
      step !== 0
        ? tabs[(index + step + tabs.length) % tabs.length]
        : event.key === "Home"
          ? tabs[0]
          : event.key === "End"
            ? tabs.at(-1)
            : undefined;
    if (!target) return;
    event.preventDefault();
    panel.select(target.id);
    buttons.current.get(target.id)?.focus();
  };
  const reducedMotion = useAppReducedMotion();
  const strip = useRef<HTMLDivElement>(null);
  // A tab opened or selected past the strip's edge is scrolled into view by
  // scrolling the strip alone. scrollIntoView also scrolls every clipped
  // ancestor: on a phone the rail slides in from off-screen, so the whole app
  // slid left to meet it and snapped back as it arrived.
  useEffect(() => {
    const list = strip.current;
    const item = activeId === null ? null : buttons.current.get(activeId)?.parentElement;
    if (!visible || !list || !item) return;
    const bounds = list.getBoundingClientRect();
    const rect = item.getBoundingClientRect();
    const by =
      rect.left < bounds.left
        ? rect.left - bounds.left
        : rect.right > bounds.right
          ? rect.right - bounds.right
          : 0;
    if (by) list.scrollBy?.({ left: by, behavior: reducedMotion ? "auto" : "smooth" });
  }, [activeId, visible, reducedMotion]);
  const register = useCallback((id: string, element: HTMLButtonElement | null) => {
    if (element) buttons.current.set(id, element);
    else buttons.current.delete(id);
  }, []);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <DragDropProvider
        sensors={TAB_SENSORS}
        modifiers={TAB_MODIFIERS}
        onDragEnd={(event) => {
          const { source } = event.operation;
          if (event.canceled || !isSortable(source)) return;
          if (source.index !== source.initialIndex) panel.moveTab(String(source.id), source.index);
        }}
      >
        {/* Electron ignores clipping for no-drag areas (electron/electron#40610)
            and tabs inherit their list's, so a scrolled-out tab would block
            dragging over the header. Only the box after the list declares one:
            the strip's visible size, transparent to clicks (styles/app.css). */}
        <div className="relative flex min-w-0">
          <div
            ref={strip}
            role="tablist"
            aria-label={m.ui_panel_tabs()}
            // The sidebar's soft edge, sideways: padding keeps the first and last tabs
            // clear of the fade when the strip is scrolled to either end.
            className="-ml-2 flex min-w-0 items-center gap-1 overflow-x-auto px-3 [mask-image:linear-gradient(to_right,transparent,black_0.75rem,black_calc(100%-0.75rem),transparent)] [scrollbar-width:none]"
            // The strip only scrolls sideways, so a plain wheel scrolls it sideways.
            onWheel={(event) => {
              if (Math.abs(event.deltaY) > Math.abs(event.deltaX))
                event.currentTarget.scrollLeft += event.deltaY;
            }}
          >
            {tabs.map((tab, index) => (
              <PanelTab
                key={tab.id}
                panel={panel}
                tab={tab}
                index={index}
                id={ids.tab(index)}
                panelId={ids.panel}
                selected={visible && tab.id === activeId}
                focusable={visible ? tab.id === activeId : index === 0}
                register={register}
                onKeyDown={onKeyDown}
              />
            ))}
          </div>
          <div aria-hidden data-tab-strip-hit="" className="pointer-events-none absolute inset-0" />
        </div>
      </DragDropProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={panel.newTab}
              aria-label={m.ui_panel_new_tab()}
              className="text-muted-foreground"
            />
          }
        >
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
        </TooltipTrigger>
        <TooltipContent>{m.ui_panel_new_tab()}</TooltipContent>
      </Tooltip>
    </div>
  );
}

function PanelTab({
  panel,
  tab,
  index,
  id,
  panelId,
  selected,
  focusable,
  register,
  onKeyDown,
}: {
  panel: DetailPanelApi;
  tab: DetailPanelTabSummary;
  index: number;
  id: string;
  panelId: string;
  selected: boolean;
  focusable: boolean;
  register: (id: string, element: HTMLButtonElement | null) => void;
  onKeyDown: (event: KeyboardEvent, index: number) => void;
}) {
  const { ref, isDragging } = useSortable({ id: tab.id, index });
  return (
    <div
      ref={ref}
      data-panel-tab=""
      className={cn(
        // The ring is inset: the strip scrolls sideways, which clips anything
        // drawn outside a tab.
        "group/tab ring-ring/50 flex h-8 max-w-48 min-w-0 shrink-0 items-center gap-0.5 rounded-md pr-0.5 ring-inset transition-colors has-[[role=tab]:focus-visible]:ring-2",
        selected
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        isDragging && "bg-muted text-foreground shadow-sm",
      )}
    >
      <button
        type="button"
        role="tab"
        id={id}
        aria-selected={selected}
        {...(selected ? { "aria-controls": panelId } : {})}
        tabIndex={focusable ? 0 : -1}
        ref={(element) => {
          register(tab.id, element);
          return () => register(tab.id, null);
        }}
        className="flex h-full min-w-0 items-center gap-1.5 pl-2 text-sm outline-none"
        onClick={() => panel.select(tab.id)}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          panel.closeTab(tab.id);
        }}
        onKeyDown={(event) => onKeyDown(event, index)}
      >
        {tab.busy ? (
          <Spinner aria-hidden className="size-4 shrink-0" />
        ) : tab.iconSrc ? (
          <img src={tab.iconSrc} alt="" className="size-4 shrink-0 rounded-sm" />
        ) : (
          <HugeiconsIcon
            icon={tab.icon ?? File01Icon}
            strokeWidth={2}
            className="size-4 shrink-0"
            aria-hidden
          />
        )}
        <span className="truncate">{tab.title}</span>
      </button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => panel.closeTab(tab.id)}
        aria-label={m.ui_panel_close_tab({ title: tab.title })}
        data-tab-close=""
        className={cn(
          "text-muted-foreground",
          !selected &&
            "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
        )}
      >
        <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
      </Button>
    </div>
  );
}
