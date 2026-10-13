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
import { circleRing, partialPath, type MapModel } from "./map-model.ts";

maplibre.setWorkerUrl(workerUrl);

const styleUrl = (dark: boolean) => `${location.origin}/api/map/style/${dark ? "dark" : "light"}`;
/** What this map adds to a style, carried across a theme change. */
const OWN_SOURCES = ["areas", "routes", "labels"];
const OWN_LAYERS = new Set(["areas", "areas-edge", "routes", "routes-straight", "labels"]);

/** How long a route takes to draw itself when it arrives. */
const DRAW_MS = 700;
/** The labels' font when the style names none MapLibre can read; OpenFreeMap serves it. */
const LABEL_FONT = ["Noto Sans Regular"];

/**
 * Routes each block has already drawn on this page, by block. A route draws
 * itself only when it arrives while the reader watches, never on a reload or
 * when the block remounts (Streamdown, the virtual list, the expanded view).
 */
const drawnRoutes = new Map<string, Set<string>>();
const MAX_BLOCKS = 200;

/** Which of these routes are new to the block; the first sight of a block counts as drawn. */
function arrivedRoutes(block: string, keys: readonly string[]): Set<string> {
  let seen = drawnRoutes.get(block);
  if (!seen) {
    drawnRoutes.set(block, new Set(keys));
    if (drawnRoutes.size > MAX_BLOCKS) {
      const oldest = drawnRoutes.keys().next().value;
      if (oldest !== undefined) drawnRoutes.delete(oldest);
    }
    return new Set();
  }
  const fresh = new Set(keys.filter((key) => !seen.has(key)));
  for (const key of fresh) seen.add(key);
  return fresh;
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

function routeFeatures(model: MapModel, drawing: ReadonlySet<string>, share: number) {
  return {
    type: "FeatureCollection" as const,
    features: model.routes.flatMap((route) =>
      route.path
        ? [
            {
              type: "Feature" as const,
              properties: { color: resolveColor(route.color), dashed: route.mode === "straight" },
              geometry: {
                type: "LineString" as const,
                coordinates: partialPath(route.path, drawing.has(route.key) ? share : 1),
              },
            },
          ]
        : [],
    ),
  };
}

/**
 * How far below its point a pin's label starts, in ems of the 12px label:
 * clear of the marker drawn there, which is larger with an emoji and when picked.
 */
function labelOffset(pin: MapModel["pins"][number], picked: boolean): number {
  if (pin.icon) return picked ? 1.8 : 1.5;
  return picked ? 1.2 : 0.9;
}

/** The font the style's own labels use, which its glyph server is sure to have. */
function labelFont(map: maplibre.Map): string[] {
  for (const layer of map.getStyle().layers) {
    if (layer.type !== "symbol") continue;
    const font: unknown = layer.layout?.["text-font"];
    if (Array.isArray(font) && font.every((name) => typeof name === "string")) return font;
  }
  return LABEL_FONT;
}

function featureCollections(model: MapModel, selected: string | null) {
  return {
    labels: {
      type: "FeatureCollection" as const,
      features: model.pins.flatMap((pin) =>
        pin.lat !== undefined && pin.lng !== undefined
          ? [
              {
                type: "Feature" as const,
                // The selected pin's label wins a collision with its neighbours'.
                properties: {
                  label: pin.label,
                  rank: pin.id === selected ? 0 : 1,
                  offset: [0, labelOffset(pin, pin.id === selected)],
                },
                geometry: { type: "Point" as const, coordinates: [pin.lng, pin.lat] },
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
/** How close a picked pin is shown: its streets, still with some neighbourhood. */
const PICK_ZOOM = 13;

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
  /**
   * A new map was made (on mount or a fixed zoom), numbered
   * so painting and revealing refer to that map, not to an earlier one.
   */
  readonly onCreated: (map: number) => void;
  /** That map's first tiles are on screen. */
  readonly onPainted: (map: number) => void;
  /** That map has faded fully in over the skeleton, which may now go. */
  readonly onRevealed: (map: number) => void;
  /** The current map has painted, so it fades in. */
  readonly shown: boolean;
  /** A view the block fixed; otherwise the map fits what it draws. */
  readonly view: { readonly center?: [number, number]; readonly zoom?: number };
  /** The block the map is in, so a route draws itself once per page, not per mount. */
  readonly block: string;
  /** Changed to fit the view to everything the map draws again. */
  readonly fitAll: number;
}

export default function MapCanvas({
  model,
  label,
  dark,
  selected,
  onSelect,
  onBroken,
  onCreated,
  onPainted,
  onRevealed,
  shown,
  view,
  block,
  fitAll,
}: MapCanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibre.Map | null>(null);
  const markers = useRef<maplibre.Marker[]>([]);
  const fitted = useRef(0);
  // The map whose layers exist. Compared with the current map in each effect,
  // so a map made since is not drawn on before its own load.
  const [loaded, setLoaded] = useState<maplibre.Map | null>(null);
  const made = useRef(0);
  const fixedZoom = view.zoom !== undefined;
  // Read when a map is made, not followed: later changes do not move a map the reader panned.
  const latest = useRef({
    model,
    onSelect,
    onBroken,
    onCreated,
    onPainted,
    onRevealed,
    view,
    dark,
  });
  useEffect(() => {
    latest.current = { model, onSelect, onBroken, onCreated, onPainted, onRevealed, view, dark };
  });

  // The theme a map was last styled for, so a theme change restyles it in place.
  const styled = useRef(dark);
  // Bumped once a restyled map has loaded, to redraw in the new theme's colours.
  const [restyled, setRestyled] = useState(0);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const opening = latest.current;
    // Open on what is already known, so the first frame is not the whole world.
    const bounds = boundsOf(opening.model);
    const known = fixedZoom ? null : bounds;
    fitted.current = known ? drawnCount(opening.model) : 0;
    // A fixed zoom without a centre opens on what the map draws, not on open sea at 0°, 20°.
    const center = opening.view.center ?? bounds?.getCenter().toArray() ?? [0, 20];
    const id = ++made.current;
    latest.current.onCreated(id);
    let map: maplibre.Map;
    try {
      map = new maplibre.Map({
        container: element,
        style: styleUrl(opening.dark),
        attributionControl: { compact: true },
        cooperativeGestures: true,
        ...(known
          ? { bounds: known, fitBoundsOptions: FIT }
          : { center, zoom: opening.view.zoom ?? 1 }),
      });
    } catch {
      latest.current.onBroken();
      return;
    }
    mapRef.current = map;
    styled.current = opening.dark;
    let everLoaded = false;
    map.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-right");
    map.once("idle", () => {
      latest.current.onPainted(id);
      // No fade to wait for.
      if (prefersReducedMotion()) latest.current.onRevealed(id);
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
      map.addSource("labels", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      // A symbol layer, not text in the markers: MapLibre hides labels that
      // would collide, so a dense map shows what fits instead of a pile.
      map.addLayer({
        id: "labels",
        type: "symbol",
        source: "labels",
        layout: {
          "text-field": ["get", "label"],
          "text-font": labelFont(map),
          "text-size": 12,
          "text-anchor": "top",
          "text-offset": ["get", "offset"],
          "text-max-width": 10,
          "symbol-sort-key": ["get", "rank"],
        },
        paint: {
          "text-color": resolveColor("foreground"),
          "text-halo-color": resolveColor("background"),
          "text-halo-width": 1.5,
        },
      });
      everLoaded = true;
      setLoaded(map);
    });
    map.on("error", () => {
      // Only a style that never loads leaves nothing to draw. isStyleLoaded is
      // also false while tiles load, so a failed tile would read the same.
      if (!everLoaded) latest.current.onBroken();
    });
    return () => {
      for (const marker of markers.current) marker.remove();
      markers.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, [fixedZoom]);

  // A theme change swaps the style under the same map: the view, the drawn
  // routes and the reader's place stay, only the basemap and colours change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || loaded !== map || styled.current === dark) return;
    styled.current = dark;
    map.setStyle(styleUrl(dark), {
      transformStyle: (previous, next) =>
        previous
          ? {
              ...next,
              sources: {
                ...next.sources,
                ...Object.fromEntries(
                  OWN_SOURCES.flatMap((id) =>
                    previous.sources[id] ? [[id, previous.sources[id]]] : [],
                  ),
                ),
              },
              layers: [
                ...next.layers,
                ...previous.layers.filter((layer) => OWN_LAYERS.has(layer.id)),
              ],
            }
          : next,
    });
    map.once("style.load", () => setRestyled((n) => n + 1));
  }, [dark, loaded]);

  // Draw what is known so far, and fit the view whenever more of it arrives.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || loaded !== map) return;
    const data = featureCollections(model, selected);
    const routes = map.getSource("routes") as maplibre.GeoJSONSource | undefined;
    (map.getSource("areas") as maplibre.GeoJSONSource | undefined)?.setData(data.areas);
    (map.getSource("labels") as maplibre.GeoJSONSource | undefined)?.setData(data.labels);
    if (map.getLayer("labels")) {
      map.setPaintProperty("labels", "text-color", resolveColor("foreground"));
      map.setPaintProperty("labels", "text-halo-color", resolveColor("background"));
    }
    for (const marker of markers.current) marker.remove();
    markers.current = model.pins.flatMap((pin) => {
      if (pin.lat === undefined || pin.lng === undefined) return [];
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("aria-label", pin.label);
      button.setAttribute("aria-pressed", String(pin.id === selected));
      // MapLibre positions this element by its transform, so only the mark inside may scale.
      // As large as the mark inside, so MapLibre centres the mark on the point.
      button.className = cn(
        "grid cursor-pointer place-items-center rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        pin.icon ? "size-7" : "size-6",
      );
      const mark = document.createElement("span");
      if (pin.icon) {
        mark.className = cn(
          "bg-background grid size-7 place-items-center rounded-full text-base leading-none shadow-md transition-[scale] motion-reduce:transition-none",
          pin.id === selected && "ring-primary scale-125 ring-2",
        );
        mark.textContent = pin.icon;
      } else {
        mark.className = cn(
          "size-4 rounded-full border-2 border-background shadow-md transition-[scale] motion-reduce:transition-none",
          pin.id === selected && "scale-150",
        );
        mark.style.background = `var(--${pin.color})`;
      }
      button.append(mark);
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

    const drawing = arrivedRoutes(
      block,
      model.routes.flatMap((route) => (route.path ? [route.key] : [])),
    );
    if (drawing.size === 0 || prefersReducedMotion()) {
      routes?.setData(routeFeatures(model, new Set(), 1));
      return;
    }
    const start = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const t = Math.min(1, (now - start) / DRAW_MS);
      routes?.setData(routeFeatures(model, drawing, 1 - (1 - t) ** 3));
      if (t < 1) frame = requestAnimationFrame(step);
    });
    return () => {
      cancelAnimationFrame(frame);
      routes?.setData(routeFeatures(model, new Set(), 1));
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `restyled` redraws in the colours of a theme the map just changed to
  }, [model, loaded, selected, fixedZoom, block, restyled]);

  // "Show all": back to everything the map draws, wherever the reader panned.
  useEffect(() => {
    const map = mapRef.current;
    const bounds = boundsOf(latest.current.model);
    if (fitAll === 0 || !map || loaded !== map || !bounds) return;
    map.fitBounds(bounds, { ...FIT, animate: !prefersReducedMotion() });
  }, [fitAll, loaded]);

  // A picked pin is flown to: out over the way between, then in on it. The
  // selection a map opens with is not a pick, and the opening view stands.
  const flownFrom = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    // Through the ref: only a new selection moves the view, not new lookups.
    const map = mapRef.current;
    if (!map || loaded !== map) return;
    const previous = flownFrom.current;
    flownFrom.current = selected;
    if (previous === undefined || previous === selected) return;
    const pin = latest.current.model.pins.find((candidate) => candidate.id === selected);
    if (pin?.lat === undefined || pin.lng === undefined) return;
    const camera = {
      center: [pin.lng, pin.lat] as [number, number],
      zoom: fixedZoom ? map.getZoom() : Math.max(map.getZoom(), PICK_ZOOM),
    };
    if (prefersReducedMotion()) map.jumpTo(camera);
    else map.flyTo({ ...camera, essential: false });
  }, [selected, loaded, fixedZoom]);

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
        if (shown && event.target === event.currentTarget) onRevealed(made.current);
      }}
    />
  );
}
