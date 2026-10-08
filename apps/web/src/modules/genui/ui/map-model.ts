// What a validated <map> draws, from its children and what the server looked
// up. Pure, so it is tested without a WebGL map: the drawing only renders it.

import { lookupOf, type UiLookups } from "~/modules/chat/assistant-output.ts";
import type { ValidNode } from "../catalog.ts";
import { normalizeQuery, routeKey, type RouteMode, type RouteStop } from "../extract.ts";

/** `pending`: still being looked up. `missing`: not found, or never looked up. `off`: maps were off. */
export type Resolution = "ready" | "pending" | "missing" | "off";

export interface MapPin {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly content: ValidNode["children"];
  readonly status: Resolution;
  readonly lat?: number;
  readonly lng?: number;
}

export interface MapRoute {
  readonly key: string;
  readonly mode: RouteMode;
  readonly label?: string;
  readonly color: string;
  readonly status: Resolution;
  /** [lng, lat] pairs. */
  readonly path?: ReadonlyArray<readonly [number, number]>;
  readonly distance?: number;
  readonly duration?: number;
}

export interface MapArea {
  readonly lat: number;
  readonly lng: number;
  readonly radius: number;
  readonly label?: string;
  readonly color: string;
}

export interface MapModel {
  readonly pins: readonly MapPin[];
  readonly routes: readonly MapRoute[];
  readonly areas: readonly MapArea[];
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);

function stopsOf(value: unknown): RouteStop[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((stop: unknown): RouteStop[] => {
    if (typeof stop === "string") return [stop];
    if (typeof stop === "object" && stop !== null && "lat" in stop && "lng" in stop) {
      const { lat, lng } = stop;
      return typeof lat === "number" && typeof lng === "number" ? [{ lat, lng }] : [];
    }
    return [];
  });
}

export function resolveMap(node: ValidNode, lookups: UiLookups, streaming: boolean): MapModel {
  const absent: Resolution = streaming ? "pending" : "missing";
  const where = (place: string) => {
    const found = lookupOf(lookups.places, normalizeQuery(place));
    if (!found) return { status: absent };
    if (found.status === "maps_off") return { status: "off" as const };
    return found.status === "resolved" && found.lat !== undefined && found.lng !== undefined
      ? { status: "ready" as const, lat: found.lat, lng: found.lng, name: found.name }
      : { status: "missing" as const };
  };

  const pins: MapPin[] = [];
  const routes: MapRoute[] = [];
  const areas: MapArea[] = [];
  node.children.forEach((child, index) => {
    if (typeof child === "string") return;
    const p = child.props;
    const color = str(p.color) ?? (child.tag === "route" ? "primary" : "chart-1");
    if (child.tag === "pin") {
      const lat = num(p.lat);
      const lng = num(p.lng);
      const place = str(p.place);
      const found =
        lat !== undefined && lng !== undefined
          ? { status: "ready" as const, lat, lng, name: undefined }
          : place
            ? where(place)
            : { status: "missing" as const };
      pins.push({
        id: str(p.id) ?? `pin-${index}`,
        label: str(p.label) ?? ("name" in found ? found.name : undefined) ?? place ?? "Place",
        color,
        content: child.children,
        status: found.status,
        ...("lat" in found ? { lat: found.lat, lng: found.lng } : {}),
      });
    } else if (child.tag === "route") {
      const mode = (str(p.mode) ?? "drive") as RouteMode;
      const stops = stopsOf(p.stops);
      const key = routeKey({ mode, stops });
      const label = str(p.label);
      if (mode === "straight") {
        const points = stops.map((stop) =>
          typeof stop === "string" ? where(stop) : { status: "ready" as const, ...stop },
        );
        const status: Resolution = points.every((pt) => pt.status === "ready")
          ? "ready"
          : (["off", "missing", "pending"] as const).find((s) =>
              points.some((pt) => pt.status === s),
            )!;
        routes.push({
          key,
          mode,
          color,
          status,
          ...(label ? { label } : {}),
          ...(status === "ready"
            ? {
                path: points.map((pt) =>
                  "lat" in pt ? ([pt.lng!, pt.lat!] as const) : ([0, 0] as const),
                ),
              }
            : {}),
        });
        return;
      }
      const found = lookupOf(lookups.routes, key);
      routes.push({
        key,
        mode,
        color,
        ...(label ? { label } : {}),
        status: !found
          ? absent
          : found.status === "maps_off"
            ? "off"
            : found.status === "resolved" && found.path
              ? "ready"
              : "missing",
        ...(found?.status === "resolved"
          ? { path: found.path, distance: found.distance, duration: found.duration }
          : {}),
      });
    } else if (child.tag === "area") {
      const lat = num(p.lat);
      const lng = num(p.lng);
      const radius = num(p.radius);
      if (lat === undefined || lng === undefined || radius === undefined) return;
      const label = str(p.label);
      areas.push({ lat, lng, radius, color, ...(label ? { label } : {}) });
    }
  });
  return { pins, routes, areas };
}

/** "34 km · 40 min" in the reader's locale; walking distances stay in metres below 1 km. */
export function routeSummary(route: MapRoute, locale?: string): string | null {
  if (route.distance === undefined || route.duration === undefined) return null;
  const km = route.distance / 1000;
  const distance =
    km < 1
      ? `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(route.distance)} m`
      : `${new Intl.NumberFormat(locale, { maximumFractionDigits: km < 10 ? 1 : 0 }).format(km)} km`;
  const minutes = Math.max(1, Math.round(route.duration / 60));
  const time =
    minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  return `${distance} · ${time}`;
}

/**
 * A circle as a polygon ring, for an area. Each point is the great-circle
 * destination from the centre, so latitudes stay valid near a pole (a flat
 * approximation divides by cos(lat), which is 0 there). Longitudes stay
 * continuous around the centre, past ±180 if need be: wrapped, a ring across
 * the date line would jump 360° and draw as a band round the world.
 */
export function circleRing(
  lat: number,
  lng: number,
  radius: number,
  steps = 64,
): Array<[number, number]> {
  const rad = Math.PI / 180;
  const distance = radius / 6_371_000;
  const phi = lat * rad;
  const ring = Array.from({ length: steps }, (_, i) => {
    const bearing = (i / steps) * 2 * Math.PI;
    const phi2 = Math.asin(
      Math.sin(phi) * Math.cos(distance) + Math.cos(phi) * Math.sin(distance) * Math.cos(bearing),
    );
    const lambda2 =
      lng * rad +
      Math.atan2(
        Math.sin(bearing) * Math.sin(distance) * Math.cos(phi),
        Math.cos(distance) - Math.sin(phi) * Math.sin(phi2),
      );
    return [lambda2 / rad, phi2 / rad] as [number, number];
  });
  ring.push(ring[0]!);
  return ring;
}
