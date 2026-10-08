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

function collect(nodes: readonly UiNode[], into: string[]): void {
  for (const node of nodes) {
    switch (node.type) {
      case "element": {
        if (node.tag === "image" || node.tag === "images") {
          const attr = node.attrs.find((a) => a.name === "query");
          if (attr?.value.kind === "literal") into.push(attr.value.value);
          else if (attr?.value.kind === "expr")
            into.push(...(literalStrings(attr.value.code) ?? []));
        }
        collect(node.children, into);
        break;
      }
      case "each":
        collect(node.body, into);
        collect(node.fallback, into);
        break;
      case "if":
        for (const branch of node.branches) collect(branch.body, into);
        if (node.fallback) collect(node.fallback, into);
        break;
      default:
        break;
    }
  }
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
