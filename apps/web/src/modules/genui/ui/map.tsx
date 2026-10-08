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
  type ReactNode,
} from "react";
import { NO_LOOKUPS } from "~/modules/chat/assistant-output.ts";
import { Skeleton } from "~/ui/primitives/skeleton";
import { cn } from "~/ui/utils";
import type { ValidNode } from "../catalog.ts";
import { GenuiMessageContext } from "./context.ts";
import { handlerOf, useHandler } from "./handler.ts";
import { resolveMap, routeSummary } from "./map-model.ts";

// MapLibre is large; it loads only for a block that draws a map.
const MapCanvas = lazy(() => import("./map-canvas.tsx"));

const MODE_LABEL = { drive: "Drive", walk: "Walk", bike: "Bike", straight: "Direct" } as const;

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

export function UiMap({
  node,
  renderContent,
}: {
  node: ValidNode;
  /** Draws a pin's own content; passed in, since the tree is what draws nodes. */
  renderContent: (nodes: ValidNode["children"]) => ReactNode;
}) {
  const p = node.props;
  const message = use(GenuiMessageContext);
  const model = useMemo(
    () => resolveMap(node, message?.lookups ?? NO_LOOKUPS, message?.streaming ?? false),
    [node, message?.lookups, message?.streaming],
  );
  const fire = useHandler(handlerOf(p.onselect), { event: "change", tag: "map" });
  const given = typeof p.selected === "string" ? p.selected : null;
  const [picked, setPicked] = useState<{ value: string | null; base: string | null } | null>(null);
  const selected = picked && picked.base === given ? picked.value : given;
  const select = (id: string) => {
    setPicked({ value: id, base: given });
    fire?.([id]);
  };

  const dark = useSyncExternalStore(observeDark, isDark, () => false);
  const [broken, setBroken] = useState(false);
  // The theme whose map has drawn its first tiles. One skeleton covers the
  // chunk loading and the tiles arriving, so it never restarts or blinks.
  const [painted, setPainted] = useState<boolean | null>(null);
  const shown = painted === dark;
  // It stays under the map until the fade ends, so the map never fades in over nothing.
  const [revealed, setRevealed] = useState<boolean | null>(null);
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
  const label = typeof p.label === "string" ? p.label : "Map";
  const height = typeof p.height === "number" ? p.height : 320;

  const pending =
    model.pins.some((pin) => pin.status === "pending") ||
    model.routes.some((r) => r.status === "pending");
  const missingPlaces = off ? [] : model.pins.filter((pin) => pin.status === "missing");
  const missingRoutes = off ? [] : model.routes.filter((route) => route.status === "missing");
  const current = model.pins.find((pin) => pin.id === selected);
  const routed = model.routes.some((route) => route.mode !== "straight" && route.path);

  return (
    <figure className="flex flex-col gap-2">
      {failed ? null : (
        <div className="relative w-full overflow-hidden rounded-2xl" style={{ height }}>
          {revealed === dark ? null : <Skeleton className="absolute inset-0" />}
          <Suspense fallback={null}>
            <MapCanvas
              model={model}
              label={label}
              dark={dark}
              selected={selected}
              onSelect={select}
              onBroken={() => setBroken(true)}
              onPainted={setPainted}
              onRevealed={setRevealed}
              shown={shown}
              view={view}
            />
          </Suspense>
        </div>
      )}
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
                  {route.label ?? MODE_LABEL[route.mode]} {routeSummary(route)}
                </li>
              ) : null,
            )}
          </ul>
        ) : null}
        {model.pins.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" aria-label="Places">
            {model.pins.map((pin) => (
              <li key={pin.id}>
                <button
                  type="button"
                  aria-pressed={pin.id === selected}
                  disabled={pin.status !== "ready"}
                  onClick={() => select(pin.id)}
                  className={cn(
                    "border-border flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50",
                    pin.id === selected ? "bg-accent" : "hover:bg-accent/60",
                  )}
                >
                  <span
                    className="size-2 rounded-full"
                    style={{ background: `var(--${pin.color})` }}
                  />
                  {pin.label}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {current && current.content.length > 0 ? (
          <div className="text-sm">{renderContent(current.content)}</div>
        ) : null}
        {off ? <span className="text-muted-foreground text-xs">Maps are off</span> : null}
        {pending ? <span className="text-muted-foreground text-xs">Finding places…</span> : null}
        {missingPlaces.length > 0 || missingRoutes.length > 0 ? (
          <span className="text-muted-foreground text-xs">
            {[
              missingPlaces.length > 0
                ? `Couldn’t find ${missingPlaces.map((pin) => pin.label).join(", ")}`
                : null,
              missingRoutes.length > 0 ? "Route unavailable" : null,
            ]
              .filter(Boolean)
              .join(". ")}
          </span>
        ) : null}
        {routed ? (
          <span className="text-muted-foreground text-xs">
            Routes from OpenStreetMap.{" "}
            <a
              href="https://www.openstreetmap.org/fixthemap"
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2"
            >
              Fix the map
            </a>
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}
