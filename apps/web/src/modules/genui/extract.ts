// Finds the image queries in an answer's ```ui blocks without running them.
// The server resolves images while the answer streams, before any browser
// has evaluated the block, so only queries written as literals count;
// a computed query renders as unavailable.

import { parseExpressionAt, type AnyNode } from "acorn";
import { scanUiFences } from "./fences.ts";
import { parseUi, type UiNode } from "./parse.ts";

export const IMAGE_QUERY_LIMITS = {
  queriesPerAnswer: 8,
  queryChars: 200,
} as const;

function stringValue(node: AnyNode | null): string | null {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((q) => q.value.cooked ?? "").join("");
  }
  return null;
}

function literalStrings(code: string): string[] | null {
  let node: AnyNode;
  try {
    node = parseExpressionAt(code, 0, { ecmaVersion: "latest" });
  } catch {
    return null;
  }
  if (code.slice(node.end).trim() !== "") return null;
  const single = stringValue(node);
  if (single !== null) return [single];
  if (node.type !== "ArrayExpression") return null;
  const out: string[] = [];
  for (const element of node.elements) {
    const value = element?.type === "SpreadElement" ? null : stringValue(element);
    if (value === null) return null;
    out.push(value);
  }
  return out;
}

/** Visits every element, inside each and if branches too. */
function walk(
  nodes: readonly UiNode[],
  visit: (node: Extract<UiNode, { type: "element" }>) => void,
) {
  for (const node of nodes) {
    if (node.type === "element") {
      visit(node);
      walk(node.children, visit);
    } else if (node.type === "each") {
      walk(node.body, visit);
      walk(node.fallback, visit);
    } else if (node.type === "if") {
      for (const branch of node.branches) walk(branch.body, visit);
      if (node.fallback) walk(node.fallback, visit);
    }
  }
}

function collect(nodes: readonly UiNode[], into: string[]): void {
  walk(nodes, (node) => {
    if (node.tag !== "image" && node.tag !== "images") return;
    const attr = node.attrs.find((a) => a.name === "query");
    if (attr?.value.kind === "literal") into.push(attr.value.value);
    else if (attr?.value.kind === "expr") into.push(...(literalStrings(attr.value.code) ?? []));
  });
}

/** Normalised so the server's key and the client's lookup agree. */
export function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

/** One block's literal image queries, normalised, without the empty or overlong. */
export function blockImageQueries(code: string): string[] {
  const raw: string[] = [];
  collect(parseUi(code).nodes, raw);
  return raw
    .map(normalizeQuery)
    .filter((query) => query !== "" && query.length <= IMAGE_QUERY_LIMITS.queryChars);
}

/**
 * Distinct image queries in closed `ui` fences, in order of appearance,
 * capped per answer. Open fences are skipped: their queries may still be
 * mid-word.
 */
export function extractImageQueries(content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const fence of scanUiFences(content)) {
    if (!fence.closed) continue;
    for (const query of blockImageQueries(fence.code)) {
      if (seen.has(query)) continue;
      if (out.length >= IMAGE_QUERY_LIMITS.queriesPerAnswer) return out;
      seen.add(query);
      out.push(query);
    }
  }
  return out;
}

export const MAP_LOOKUP_LIMITS = {
  placesPerAnswer: 20,
  routesPerAnswer: 5,
  stopsPerRoute: 10,
} as const;

/**
 * What the page may add to a finished answer for maps its state computes, on
 * top of what streaming looked up. High, since every edit is a new stop list.
 */
export const PAGE_LOOKUP_LIMITS = {
  placesPerAnswer: 40,
  routesPerAnswer: 30,
} as const;

const QUOTED = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\$]|\\.)*)`/g;

/**
 * Every quoted string in a block's source, normalised: attribute values and
 * script literals alike. A name the page asks the server to look up must be
 * one of them, so only what the model wrote ever leaves, never what the
 * reader typed into the block.
 */
export function quotedStrings(code: string): Set<string> {
  const out = new Set<string>();
  for (const match of code.matchAll(QUOTED)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? "";
    const text = raw.replace(/\\(.)/g, "$1");
    const normalized = normalizeQuery(text);
    if (normalized !== "") out.add(normalized);
  }
  return out;
}

export type RouteMode = "drive" | "walk" | "bike" | "straight";
export const ROUTE_MODES: readonly RouteMode[] = ["drive", "walk", "bike", "straight"];

/** A route stop: a place name to look up, or coordinates the block gave. */
export type RouteStop = string | { readonly lat: number; readonly lng: number };

export interface RouteRequest {
  readonly mode: RouteMode;
  readonly stops: readonly RouteStop[];
}

const coordinate = (value: number) => Math.round(value * 1e5) / 1e5;

/** How server and page name one route, so the page finds what the server stored. */
export function routeKey(route: RouteRequest): string {
  const stops = route.stops.map((stop) =>
    typeof stop === "string" ? normalizeQuery(stop) : [coordinate(stop.lat), coordinate(stop.lng)],
  );
  return `${route.mode}:${JSON.stringify(stops)}`;
}

function attrText(node: Extract<UiNode, { type: "element" }>, name: string): string | null {
  const attr = node.attrs.find((a) => a.name === name);
  if (attr?.value.kind === "literal") return attr.value.value;
  if (attr?.value.kind === "expr") {
    const values = literalStrings(attr.value.code);
    return values?.length === 1 ? values[0]! : null;
  }
  return null;
}

function literalStops(code: string): RouteStop[] | null {
  let node: AnyNode;
  try {
    node = parseExpressionAt(code, 0, { ecmaVersion: "latest" });
  } catch {
    return null;
  }
  if (code.slice(node.end).trim() !== "" || node.type !== "ArrayExpression") return null;
  const stops: RouteStop[] = [];
  for (const element of node.elements) {
    const text = element?.type === "SpreadElement" ? null : stringValue(element);
    if (text !== null) {
      stops.push(text);
      continue;
    }
    if (element?.type !== "ObjectExpression") return null;
    const numbers: Record<string, number> = {};
    for (const prop of element.properties) {
      if (prop.type !== "Property" || prop.key.type !== "Identifier") return null;
      const value = prop.value;
      const n =
        value.type === "Literal" && typeof value.value === "number"
          ? value.value
          : value.type === "UnaryExpression" &&
              value.operator === "-" &&
              value.argument.type === "Literal" &&
              typeof value.argument.value === "number"
            ? -value.argument.value
            : null;
      if (n === null) return null;
      numbers[prop.key.name] = n;
    }
    const { lat, lng } = numbers;
    if (lat === undefined || lng === undefined || Math.abs(lat) > 90 || Math.abs(lng) > 180)
      return null;
    stops.push({ lat, lng });
  }
  return stops;
}

/**
 * The place names and routes one block's maps need looked up, literal only:
 * pins with a place, and routes whose stops are written out. A computed one
 * draws only if it gives coordinates itself.
 */
export function blockMapLookups(code: string): { places: string[]; routes: RouteRequest[] } {
  const places: string[] = [];
  const routes: RouteRequest[] = [];
  walk(parseUi(code).nodes, (node) => {
    if (node.tag === "pin") {
      const place = attrText(node, "place");
      if (place !== null) places.push(normalizeQuery(place));
    } else if (node.tag === "route") {
      const mode = attrText(node, "mode") ?? "drive";
      const attr = node.attrs.find((a) => a.name === "stops");
      const stops = attr?.value.kind === "expr" ? literalStops(attr.value.code) : null;
      if (!ROUTE_MODES.includes(mode as RouteMode) || !stops) return;
      const usable = stops.slice(0, MAP_LOOKUP_LIMITS.stopsPerRoute);
      if (usable.length < 2) return;
      for (const stop of usable) if (typeof stop === "string") places.push(normalizeQuery(stop));
      routes.push({ mode: mode as RouteMode, stops: usable });
    }
  });
  return {
    places: places.filter((p) => p !== "" && p.length <= IMAGE_QUERY_LIMITS.queryChars),
    routes,
  };
}
