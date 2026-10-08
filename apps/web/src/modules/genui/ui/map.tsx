// A <map> in a ui block, drawn with MapLibre from tiles the server proxies.
// Loaded on its own, only when a block has a map. The list beside it names
// every place, works by keyboard, and is what remains when no map can draw.

import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import * as maplibre from "maplibre-gl";
import { use, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { NO_LOOKUPS } from "~/modules/chat/assistant-output.ts";
import { prefersReducedMotion } from "~/ui/reduced-motion.ts";
import { cn } from "~/ui/utils";
import type { ValidNode } from "../catalog.ts";
import { GenuiMessageContext } from "./context.ts";
import { handlerOf, useHandler } from "./handler.ts";
import { circleRing, resolveMap, routeSummary, type MapModel } from "./map-model.ts";
import { Nodes } from "./tree.tsx";

maplibre.setWorkerUrl(workerUrl);

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

/** A theme colour as rgb, which MapLibre's layers can read; CSS variables and oklch they cannot. */
function resolveColor(name: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "#2a78d6";
  ctx.fillStyle =
    getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim() || "#2a78d6";
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

function featureCollections(model: MapModel) {
  return {
    routes: {
      type: "FeatureCollection" as const,
      features: model.routes.flatMap((route) =>
        route.path
          ? [
              {
                type: "Feature" as const,
                properties: { color: resolveColor(route.color), dashed: route.mode === "straight" },
                geometry: {
                  type: "LineString" as const,
                  coordinates: route.path.map(([x, y]) => [x, y]),
                },
              },
            ]
          : [],
      ),
    },
    areas: {
      type: "FeatureCollection" as const,
      features: model.areas.map((area) => ({
        type: "Feature" as const,
        properties: { color: resolveColor(area.color) },
        geometry: {
          type: "Polygon" as const,
          coordinates: [circleRing(area.lat, area.lng, area.radius)],
        },
      })),
    },
  };
}

function boundsOf(model: MapModel): maplibre.LngLatBounds | null {
  const bounds = new maplibre.LngLatBounds();
  let any = false;
  const add = (lng: number, lat: number) => {
    bounds.extend([lng, lat]);
    any = true;
  };
  for (const pin of model.pins)
    if (pin.lat !== undefined && pin.lng !== undefined) add(pin.lng, pin.lat);
  for (const route of model.routes) for (const [lng, lat] of route.path ?? []) add(lng, lat);
  for (const area of model.areas)
    for (const [lng, lat] of circleRing(area.lat, area.lng, area.radius, 16)) add(lng, lat);
  return any ? bounds : null;
}

export default function UiMap({ node }: { node: ValidNode }) {
  const p = node.props;
  const message = use(GenuiMessageContext);
  const model = useMemo(
    () => resolveMap(node, message?.lookups ?? NO_LOOKUPS, message?.streaming ?? false),
    [node, message?.lookups, message?.streaming],
  );
  const fire = useHandler(handlerOf(p.onselect), { event: "change", tag: "map" });
  const mapRef = useRef<maplibre.Map | null>(null);
  const given = typeof p.selected === "string" ? p.selected : null;
  const [picked, setPicked] = useState<{ value: string | null; base: string | null } | null>(null);
  const selected = picked && picked.base === given ? picked.value : given;
  const select = (id: string) => {
    setPicked({ value: id, base: given });
    fire?.([id]);
    // A pin chosen from the list may be off screen; bring it into view.
    const pin = model.pins.find((candidate) => candidate.id === id);
    const map = mapRef.current;
    if (map && pin?.lat !== undefined && pin.lng !== undefined) {
      const at: [number, number] = [pin.lng, pin.lat];
      if (!map.getBounds().contains(at))
        map.easeTo({ center: at, animate: !prefersReducedMotion() });
    }
  };
  // Markers are DOM nodes MapLibre owns; their listeners reach the current select through this.
  const selectRef = useRef(select);
  useEffect(() => {
    selectRef.current = select;
  });

  const dark = useSyncExternalStore(observeDark, isDark, () => false);
  const container = useRef<HTMLDivElement>(null);
  const markers = useRef<maplibre.Marker[]>([]);
  const fitted = useRef(0);
  // The theme whose map has loaded, so a theme change is not ready until its own map is.
  const [loaded, setLoaded] = useState<boolean | null>(null);
  const ready = loaded === dark;
  const [broken, setBroken] = useState(false);
  const off =
    model.pins.some((pin) => pin.status === "off") ||
    model.routes.some((route) => route.status === "off");
  // Maps off means the server serves no tiles either; the list is all there is.
  const failed = broken || off || !canDraw();
  const center = p.center as { lat: number; lng: number } | undefined;
  // The opening view only; later prop changes do not move a map the reader has panned.
  const opening = useRef({
    center: center ? ([center.lng, center.lat] as [number, number]) : ([0, 20] as [number, number]),
    zoom: typeof p.zoom === "number" ? p.zoom : 1,
  });
  const fixedZoom = typeof p.zoom === "number";
  const label = typeof p.label === "string" ? p.label : "Map";
  const height = typeof p.height === "number" ? p.height : 320;

  // One map per theme: a style swap would drop the layers drawn on it.
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    fitted.current = 0;
    let map: maplibre.Map;
    try {
      map = new maplibre.Map({
        container: element,
        style: `${location.origin}/api/map/style/${dark ? "dark" : "light"}`,
        attributionControl: { compact: true },
        cooperativeGestures: true,
        ...opening.current,
      });
    } catch {
      return;
    }
    mapRef.current = map;
    map.on("load", () => {
      map.addSource("areas", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addSource("routes", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "areas",
        type: "fill",
        source: "areas",
        paint: { "fill-color": ["get", "color"], "fill-opacity": 0.18 },
      });
      map.addLayer({
        id: "areas-edge",
        type: "line",
        source: "areas",
        paint: { "line-color": ["get", "color"], "line-width": 1.5 },
      });
      map.addLayer({
        id: "routes",
        type: "line",
        source: "routes",
        layout: { "line-join": "round", "line-cap": "round" },
        filter: ["!", ["get", "dashed"]],
        paint: { "line-color": ["get", "color"], "line-width": 4, "line-opacity": 0.9 },
      });
      // A straight line is not a road; dashing says so.
      map.addLayer({
        id: "routes-straight",
        type: "line",
        source: "routes",
        filter: ["get", "dashed"],
        paint: { "line-color": ["get", "color"], "line-width": 2.5, "line-dasharray": [2, 2] },
      });
      setLoaded(dark);
    });
    map.on("error", () => {
      // Only a style that never loads leaves nothing to draw; a missing tile is not that.
      if (!map.isStyleLoaded()) setBroken(true);
    });
    return () => {
      for (const marker of markers.current) marker.remove();
      markers.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, [dark]);

  // Draw what is known so far, and fit the view whenever more of it arrives.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const data = featureCollections(model);
    (map.getSource("routes") as maplibre.GeoJSONSource | undefined)?.setData(data.routes);
    (map.getSource("areas") as maplibre.GeoJSONSource | undefined)?.setData(data.areas);
    for (const marker of markers.current) marker.remove();
    markers.current = model.pins.flatMap((pin) => {
      if (pin.lat === undefined || pin.lng === undefined) return [];
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("aria-label", pin.label);
      button.setAttribute("aria-pressed", String(pin.id === selected));
      // MapLibre positions this element by its transform, so only the dot inside may scale.
      button.className =
        "grid size-6 cursor-pointer place-items-center rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
      const dot = document.createElement("span");
      dot.className = cn(
        "size-4 rounded-full border-2 border-background shadow-md transition-[scale] motion-reduce:transition-none",
        pin.id === selected && "scale-150",
      );
      dot.style.background = `var(--${pin.color})`;
      button.append(dot);
      button.addEventListener("click", () => selectRef.current(pin.id));
      return [new maplibre.Marker({ element: button }).setLngLat([pin.lng, pin.lat]).addTo(map)];
    });
    const count =
      data.routes.features.length +
      model.pins.filter((pin) => pin.lat !== undefined).length +
      model.areas.length;
    const bounds = boundsOf(model);
    if (bounds && count !== fitted.current && !fixedZoom) {
      const first = fitted.current === 0;
      fitted.current = count;
      map.fitBounds(bounds, {
        padding: 48,
        maxZoom: 14,
        animate: !first && !prefersReducedMotion(),
      });
    }
  }, [model, ready, selected, fixedZoom]);

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
        <div
          ref={container}
          role="region"
          aria-label={label}
          className="bg-muted w-full overflow-hidden rounded-xl"
          style={{ height }}
        />
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
          <div className="text-sm">
            <Nodes nodes={current.content} />
          </div>
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
