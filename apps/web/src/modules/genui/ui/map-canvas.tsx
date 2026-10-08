// The MapLibre drawing of a ui block's <map>: tiles through the server's
// proxy, routes and areas as layers, pins as buttons. Its own chunk, loaded
// only for a block with a map, into a box the figure has already sized.

import "maplibre-gl/dist/maplibre-gl.css";
import "./map-canvas.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import * as maplibre from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "~/ui/reduced-motion.ts";
import { cn } from "~/ui/utils";
import { circleRing, type MapModel } from "./map-model.ts";

maplibre.setWorkerUrl(workerUrl);

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

/** How many things the map draws, so the view refits only when more arrive. */
function drawnCount(model: MapModel): number {
  return (
    model.routes.filter((route) => route.path).length +
    model.pins.filter((pin) => pin.lat !== undefined).length +
    model.areas.length
  );
}

const FIT = { padding: 48, maxZoom: 14 } as const;

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

export interface MapCanvasProps {
  readonly model: MapModel;
  readonly label: string;
  readonly dark: boolean;
  readonly selected: string | null;
  readonly onSelect: (id: string) => void;
  /** The style never loaded: the figure falls back to its list. */
  readonly onBroken: () => void;
  /** The first tiles of the map for this theme are on screen. */
  readonly onPainted: (dark: boolean) => void;
  /** The map has faded fully in over the skeleton, which may now go. */
  readonly onRevealed: (dark: boolean) => void;
  /** This theme's map has painted, so it fades in. */
  readonly shown: boolean;
  /** A view the block fixed; otherwise the map fits what it draws. */
  readonly view: { readonly center?: [number, number]; readonly zoom?: number };
}

export default function MapCanvas({
  model,
  label,
  dark,
  selected,
  onSelect,
  onBroken,
  onPainted,
  onRevealed,
  shown,
  view,
}: MapCanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibre.Map | null>(null);
  const markers = useRef<maplibre.Marker[]>([]);
  const fitted = useRef(0);
  // The theme whose map has loaded, so a theme change is not ready until its own map is.
  const [loaded, setLoaded] = useState<boolean | null>(null);
  const ready = loaded === dark;
  const fixedZoom = view.zoom !== undefined;
  // Read when a map is made, not followed: later changes do not move a map the reader panned.
  const latest = useRef({ model, onSelect, onBroken, onPainted, onRevealed, view });
  useEffect(() => {
    latest.current = { model, onSelect, onBroken, onPainted, onRevealed, view };
  });

  // One map per theme: a style swap would drop the layers drawn on it.
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const opening = latest.current;
    // Open on what is already known, so the first frame is not the whole world.
    const known = fixedZoom ? null : boundsOf(opening.model);
    fitted.current = known ? drawnCount(opening.model) : 0;
    let map: maplibre.Map;
    try {
      map = new maplibre.Map({
        container: element,
        style: `${location.origin}/api/map/style/${dark ? "dark" : "light"}`,
        attributionControl: { compact: true },
        cooperativeGestures: true,
        ...(known
          ? { bounds: known, fitBoundsOptions: FIT }
          : { center: opening.view.center ?? [0, 20], zoom: opening.view.zoom ?? 1 }),
      });
    } catch {
      latest.current.onBroken();
      return;
    }
    mapRef.current = map;
    map.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-right");
    map.once("idle", () => {
      latest.current.onPainted(dark);
      // No fade to wait for.
      if (prefersReducedMotion()) latest.current.onRevealed(dark);
    });
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
      if (!map.isStyleLoaded()) latest.current.onBroken();
    });
    return () => {
      for (const marker of markers.current) marker.remove();
      markers.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, [dark, fixedZoom]);

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
      button.addEventListener("click", () => latest.current.onSelect(pin.id));
      return [new maplibre.Marker({ element: button }).setLngLat([pin.lng, pin.lat]).addTo(map)];
    });
    const count = drawnCount(model);
    const bounds = boundsOf(model);
    if (bounds && count !== fitted.current && !fixedZoom) {
      const first = fitted.current === 0;
      fitted.current = count;
      map.fitBounds(bounds, { ...FIT, animate: !first && !prefersReducedMotion() });
    }
  }, [model, ready, selected, fixedZoom]);

  // A pin chosen from the list may be off screen; bring it into view.
  useEffect(() => {
    // Through the ref: only a new selection moves the view, not new lookups.
    const map = mapRef.current;
    const pin = latest.current.model.pins.find((candidate) => candidate.id === selected);
    if (!map || !ready || pin?.lat === undefined || pin.lng === undefined) return;
    const at: [number, number] = [pin.lng, pin.lat];
    if (!map.getBounds().contains(at)) map.easeTo({ center: at, animate: !prefersReducedMotion() });
  }, [selected, ready]);

  return (
    <div
      ref={container}
      data-genui-map
      role="region"
      aria-label={label}
      className={cn(
        "absolute inset-0 transition-opacity duration-200 motion-reduce:transition-none",
        shown ? "opacity-100" : "opacity-0",
      )}
      onTransitionEnd={(event) => {
        if (shown && event.target === event.currentTarget) onRevealed(dark);
      }}
    />
  );
}
