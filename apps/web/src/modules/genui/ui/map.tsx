// A <map> in a ui block. The figure, its place list and its notes render
// with the block; only the MapLibre canvas loads on its own, into a box this
// already sized, so nothing below it moves when it arrives. The list names
// every place, works by keyboard, and is what remains when no map can draw.

import {
  lazy,
  Suspense,
  use,
  useMemo,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { CenterFocusIcon, FullScreenIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "~/ui/primitives/button";
import { Dialog, DialogContent, DialogTitle } from "~/ui/primitives/dialog";
import { Skeleton } from "~/ui/primitives/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { cn } from "~/ui/utils";
import type { ValidNode } from "../catalog.ts";
import { BlockKeyContext } from "./context.ts";
import { handlerOf, useHandler } from "./handler.ts";
import { resolveMap, routeSummary, type MapModel } from "./map-model.ts";
import { useMapLookups } from "./map-requests.ts";
import { m } from "~/paraglide/messages.js";
import { formatLocale } from "~/i18n/formats.ts";
import { getLocale } from "~/paraglide/runtime.js";

// MapLibre is large; it loads only for a block that draws a map.
const MapCanvas = lazy(() => import("./map-canvas.tsx"));

const MODE_LABEL = {
  drive: m.genui_map_mode_drive,
  walk: m.genui_map_mode_walk,
  bike: m.genui_map_mode_bike,
  straight: m.genui_map_mode_straight,
} as const;

const observeDark = (notify: () => void) => {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
};
const isDark = () => document.documentElement.classList.contains("dark");

let webgl: boolean | undefined;
/** Asked once: without WebGL the place list is the whole map. */
function canDraw(): boolean {
  if (webgl === undefined) {
    try {
      webgl = document.createElement("canvas").getContext("webgl2") !== null;
    } catch {
      webgl = false;
    }
  }
  return webgl;
}

/** The drawn map in a box already sized, under one skeleton until its first tiles are in. */
function MapBox({
  model,
  label,
  selected,
  onSelect,
  view,
  block,
  fitAll,
  onBroken,
  className,
  style,
}: {
  model: MapModel;
  label: string;
  selected: string | null;
  onSelect: (id: string) => void;
  view: { center?: [number, number]; zoom?: number };
  block: string;
  fitAll: number;
  onBroken: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  const dark = useSyncExternalStore(observeDark, isDark, () => false);
  // The theme whose map has drawn its first tiles. One skeleton covers the
  // chunk loading and the tiles arriving, so it never restarts or blinks.
  // By map number, so a map made since (a fixed zoom) starts hidden again.
  const [created, setCreated] = useState(0);
  const [painted, setPainted] = useState(0);
  const shown = created > 0 && painted === created;
  // It stays under the map until the fade ends, so the map never fades in over nothing.
  const [revealed, setRevealed] = useState(0);
  return (
    <div className={cn("relative w-full overflow-hidden rounded-2xl", className)} style={style}>
      {created > 0 && revealed === created ? null : <Skeleton className="absolute inset-0" />}
      <Suspense fallback={null}>
        <MapCanvas
          model={model}
          label={label}
          dark={dark}
          selected={selected}
          onSelect={onSelect}
          onBroken={onBroken}
          onCreated={setCreated}
          onPainted={setPainted}
          onRevealed={setRevealed}
          shown={shown}
          view={view}
          block={block}
          fitAll={fitAll}
        />
      </Suspense>
    </div>
  );
}

function MapButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: typeof FullScreenIcon;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant="secondary" size="icon-sm" aria-label={label} onClick={onClick} />}
      >
        <HugeiconsIcon icon={icon} strokeWidth={2} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function PlaceList({
  model,
  selected,
  onSelect,
}: {
  model: MapModel;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  if (model.pins.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={m.genui_map_places()}>
      {model.pins.map((pin) => (
        <li key={pin.id}>
          <button
            type="button"
            aria-pressed={pin.id === selected}
            disabled={pin.status !== "ready"}
            onClick={() => onSelect(pin.id)}
            className={cn(
              "border-border flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50",
              pin.id === selected ? "bg-accent" : "hover:bg-accent/60",
            )}
          >
            {pin.icon ? (
              <span aria-hidden>{pin.icon}</span>
            ) : (
              <span className="size-2 rounded-full" style={{ background: `var(--${pin.color})` }} />
            )}
            {pin.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function UiMap({
  node,
  renderContent,
}: {
  node: ValidNode;
  /** Draws a pin's own content; passed in, since the tree is what draws nodes. */
  renderContent: (nodes: ValidNode["children"]) => ReactNode;
}) {
  const p = node.props;
  const block = use(BlockKeyContext);
  const { lookups, waiting } = useMapLookups(node);
  const model = useMemo(() => resolveMap(node, lookups, waiting), [node, lookups, waiting]);
  const fire = useHandler(handlerOf(p.onselect), { event: "change", tag: "map" });
  const given = typeof p.selected === "string" ? p.selected : null;
  const [picked, setPicked] = useState<{ value: string | null; base: string | null } | null>(null);
  const selected = picked && picked.base === given ? picked.value : given;
  const select = (id: string) => {
    setPicked({ value: id, base: given });
    fire?.([id]);
  };

  const [broken, setBroken] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [fitAll, setFitAll] = useState(0);
  const off =
    model.pins.some((pin) => pin.status === "off") ||
    model.routes.some((route) => route.status === "off");
  // Maps off means the server serves no tiles either; the list is all there is.
  const failed = broken || off || !canDraw();
  const center = p.center as { lat: number; lng: number } | undefined;
  const view = {
    ...(center ? { center: [center.lng, center.lat] as [number, number] } : {}),
    ...(typeof p.zoom === "number" ? { zoom: p.zoom } : {}),
  };
  const label = typeof p.label === "string" ? p.label : m.genui_map_label();
  const height = typeof p.height === "number" ? p.height : 320;

  const pending =
    model.pins.some((pin) => pin.status === "pending") ||
    model.routes.some((r) => r.status === "pending");
  const missingPlaces = off ? [] : model.pins.filter((pin) => pin.status === "missing");
  const missingRoutes = off ? [] : model.routes.filter((route) => route.status === "missing");
  const current = model.pins.find((pin) => pin.id === selected);
  const shared = {
    model,
    label,
    selected,
    onSelect: select,
    view,
    block,
    onBroken: () => setBroken(true),
  };

  return (
    <figure
      className="flex flex-col gap-2"
      data-ui-anchor={typeof p.anchor === "string" ? p.anchor : undefined}
    >
      {failed ? null : (
        <div className="relative">
          <MapBox {...shared} fitAll={fitAll} style={{ height }} />
          <div className="absolute top-2 left-2 flex gap-1.5">
            <MapButton
              label={m.genui_map_expand()}
              icon={FullScreenIcon}
              onClick={() => setExpanded(true)}
            />
            {view.zoom === undefined ? (
              <MapButton
                label={m.genui_map_show_all()}
                icon={CenterFocusIcon}
                onClick={() => setFitAll((n) => n + 1)}
              />
            ) : null}
          </div>
        </div>
      )}
      {expanded && !failed ? (
        <Dialog open onOpenChange={(open) => setExpanded(open)}>
          <DialogContent className="sm:max-w-5xl">
            <DialogTitle>{label}</DialogTitle>
            {/* Its own map: moving the inline canvas into a portal would remount it anyway. */}
            <MapBox {...shared} fitAll={0} className="h-[min(70dvh,640px)]" />
            <PlaceList model={model} selected={selected} onSelect={select} />
            {current && current.content.length > 0 ? (
              <div className="text-sm">{renderContent(current.content)}</div>
            ) : null}
          </DialogContent>
        </Dialog>
      ) : null}
      <figcaption className="flex flex-col gap-2 text-sm">
        {model.routes.some((r) => r.distance !== undefined) ? (
          <ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {model.routes.map((route) =>
              route.distance !== undefined ? (
                <li key={route.key} className="flex items-center gap-1.5">
                  <span
                    className="h-0.5 w-3 rounded-full"
                    style={{ background: `var(--${route.color})` }}
                  />
                  {route.label ?? MODE_LABEL[route.mode]()} {routeSummary(route, formatLocale())}
                </li>
              ) : null,
            )}
          </ul>
        ) : null}
        <PlaceList model={model} selected={selected} onSelect={select} />
        {current && current.content.length > 0 ? (
          <div className="text-sm">{renderContent(current.content)}</div>
        ) : null}
        {off ? <span className="text-muted-foreground text-xs">{m.genui_map_off()}</span> : null}
        {pending ? (
          <span className="text-muted-foreground text-xs">{m.genui_map_finding()}</span>
        ) : null}
        {missingPlaces.length > 0 || missingRoutes.length > 0 ? (
          <span className="text-muted-foreground text-xs">
            {[
              missingPlaces.length > 0
                ? m.genui_map_not_found({
                    places: new Intl.ListFormat(getLocale()).format(
                      missingPlaces.map((pin) => pin.label),
                    ),
                  })
                : null,
              missingRoutes.length > 0 ? m.genui_map_route_unavailable() : null,
            ]
              .filter(Boolean)
              .join(". ")}
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}
