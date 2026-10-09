import { MCP_LIMITS, type JsonSchemaObject } from "../catalog.ts";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Keywords whose value is data, never a schema to look inside. */
const DATA = new Set([
  "const",
  "enum",
  "default",
  "examples",
  "required",
  "type",
  "dependentRequired",
  "format",
  "title",
  "description",
  "$comment",
]);
/** Keywords whose value maps names to schemas. */
const NAMED = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
  "$defs",
  "definitions",
]);

const MAX_DEPTH = 64;
const MAX_PATTERN = 500;

class Unusable extends Error {}

/**
 * Whether a pattern could take exponential time on a crafted string: a
 * repeated group that itself repeats or alternates, like `(a+)+` or
 * `(a|aa)*`. Erring towards yes only costs a local check the server makes
 * anyway; erring towards no could stall the one process every chat runs in.
 */
export const costlyPattern = (pattern: string) => {
  if (pattern.length > MAX_PATTERN) return true;
  // Per open group: whether something inside repeats or alternates.
  const groups: boolean[] = [];
  let lastGroupRepeats = false;
  let afterGroup = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "\\") {
      i++;
      afterGroup = false;
      continue;
    }
    if (char === "[") {
      while (i < pattern.length && pattern[i] !== "]") i += pattern[i] === "\\" ? 2 : 1;
      afterGroup = false;
      continue;
    }
    if (char === "(") {
      groups.push(false);
      afterGroup = false;
      continue;
    }
    if (char === ")") {
      lastGroupRepeats = groups.pop() ?? false;
      // A group that repeats inside makes the group around it repeat inside too.
      if (lastGroupRepeats && groups.length) groups[groups.length - 1] = true;
      afterGroup = true;
      continue;
    }
    const unbounded =
      char === "*" || char === "+" || (char === "{" && /^\{\d*,\d*\}/.test(pattern.slice(i)));
    if (unbounded && afterGroup && lastGroupRepeats) return true;
    if ((char === "|" || unbounded) && groups.length) groups[groups.length - 1] = true;
    afterGroup = false;
  }
  return false;
};

/**
 * The schema arguments are checked against: the server's own, as it wrote
 * it, never inlined or rewritten, so a mistake in what the model is shown
 * cannot let a wrong argument through. Only what would make checking unsafe
 * goes: `$async`, which turns a check into a promise read as valid, and
 * patterns that could stall the process. The server checks those itself.
 */
export const validationSchema = (
  schema: unknown,
): { schema: JsonSchemaObject } | { error: string } => {
  if (schema === undefined) return { schema: { type: "object", properties: {} } };
  if (!isObject(schema)) return { error: "Its input schema is not an object." };
  const walk = (node: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH) throw new Unusable("Its input schema is nested too deeply.");
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    if (!isObject(node)) return node;
    const out: Json = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$async") continue;
      if (key === "pattern" && typeof value === "string") {
        if (!costlyPattern(value)) out.pattern = value;
        continue;
      }
      if (DATA.has(key)) out[key] = value;
      else if (NAMED.has(key) && isObject(value)) {
        // A costly key here would run against every argument name the model sends.
        if (key === "patternProperties" && Object.keys(value).some(costlyPattern))
          throw new Unusable("It names its arguments with a pattern too costly to check.");
        out[key] = Object.fromEntries(
          Object.entries(value).map(([name, inner]) => [name, walk(inner, depth + 1)]),
        );
      } else out[key] = walk(value, depth + 1);
    }
    return out;
  };
  try {
    const kept = walk(schema, 0) as Json;
    if (JSON.stringify(kept).length > MCP_LIMITS.schemaBytes)
      return { error: "Its input schema is too large to offer." };
    return { schema: kept as JsonSchemaObject };
  } catch (error) {
    if (error instanceof Unusable) return { error: error.message };
    return { error: "Its input schema could not be read." };
  }
};
