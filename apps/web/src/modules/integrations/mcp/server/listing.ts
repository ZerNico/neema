import { createHash } from "node:crypto";
import {
  accessFromAnnotations,
  assignKeys,
  MCP_LIMITS,
  type JsonSchemaObject,
  type McpAnnotations,
  type McpToolEntry,
} from "../catalog.ts";
import { argumentCheck } from "./validate.ts";
import { validationSchema } from "./validation.ts";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Keywords a provider has no use for, or that hold definitions we inline. */
const DROPPED = new Set(["$schema", "$id", "$defs", "definitions", "$comment", "$async"]);
/** Keywords whose value is data, copied as written: `{"$ref": …}` in a `const` is a value. */
const LITERAL = new Set([
  "const",
  "enum",
  "default",
  "examples",
  "required",
  "type",
  "dependentRequired",
]);
/** Keywords whose value maps names to schemas: a property may be called `definitions`. */
const NAMED = new Set(["properties", "patternProperties", "dependentSchemas"]);
/** Keywords that only describe: a sibling of a reference simply replaces the target's. */
const DESCRIBING = new Set(["title", "description", "default", "examples", "deprecated"]);

/**
 * Draft-07 spellings as 2020-12 says them. The `$schema` that named the
 * dialect is dropped from what the model is shown, and providers read
 * 2020-12, so `dependencies` and tuple `items` are rewritten as they mean.
 */
const as2020 = (node: Json): Json => {
  let out = node;
  if (Array.isArray(out.items) && out.prefixItems === undefined) {
    const { items, additionalItems, ...rest } = out;
    out = {
      ...rest,
      prefixItems: items,
      ...(additionalItems === undefined ? {} : { items: additionalItems }),
    };
  }
  if (isObject(out.dependencies)) {
    const { dependencies, ...rest } = out;
    const required: Json = {};
    const schemas: Json = {};
    for (const [name, value] of Object.entries(dependencies))
      (Array.isArray(value) ? required : schemas)[name] = value;
    out = {
      ...rest,
      ...(Object.keys(required).length
        ? {
            dependentRequired: {
              ...(isObject(rest.dependentRequired) ? rest.dependentRequired : {}),
              ...required,
            },
          }
        : {}),
      ...(Object.keys(schemas).length
        ? {
            dependentSchemas: {
              ...(isObject(rest.dependentSchemas) ? rest.dependentSchemas : {}),
              ...schemas,
            },
          }
        : {}),
    };
  }
  return out;
};

/** Inlining stops here; deeper (or recursive) references become an open schema. */
const MAX_DEPTH = 8;
/**
 * Nodes one schema may expand to. A few references that each name the next
 * twice multiply past any size check, so expansion stops counting here.
 */
const MAX_NODES = 5_000;
/**
 * Characters one schema may expand to, keys and values together. A few
 * nodes holding a long string multiply just as well, and the size check
 * after expanding would come too late.
 */
const MAX_CHARS = MCP_LIMITS.schemaBytes * 4;

/** Deeper than this, nothing a tool takes is plausible, and recursion gets risky. */
const MAX_NESTING = 64;

class TooComplex extends Error {}

type Budget = { nodes: number; chars: number };

const spend = (budget: Budget, chars: number) => {
  budget.chars += chars;
  if (++budget.nodes > MAX_NODES || budget.chars > MAX_CHARS) throw new TooComplex();
};

const resolvePointer = (root: Json, ref: string): unknown => {
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObject(node)) return undefined;
    node = node[part];
  }
  return node;
};

/** One schema with local references inlined; keywords say what is a schema and what is data. */
const inline = (
  node: unknown,
  root: Json,
  depth: number,
  trail: ReadonlySet<string>,
  budget: Budget,
): unknown => {
  spend(budget, typeof node === "string" ? node.length : 0);
  if (!isObject(node)) return node;
  const ref = typeof node.$ref === "string" ? node.$ref : null;
  if (ref) {
    const found = resolvePointer(root, ref);
    // `true` and `false` are schemas too: anything, and nothing.
    const target = found === true ? {} : found === false ? { not: {} } : found;
    // A remote, missing or recursive reference accepts anything here; arguments
    // are checked against the server's own schema, so this only loses detail.
    if (!isObject(target) || trail.has(ref) || depth >= MAX_DEPTH) {
      const { $ref: _ref, ...rest } = node;
      return inline(rest, root, depth, trail, budget);
    }
    const { $ref: _ref, ...siblings } = node;
    // Siblings that only describe, or repeat the target, merge into it. Ones
    // that say something else about the same keyword stay a separate branch.
    const clash = Object.entries(siblings).some(
      ([key, value]) =>
        key in target && !DESCRIBING.has(key) && canonical(value) !== canonical(target[key]),
    );
    const merged = clash ? { allOf: [target, siblings] } : { ...target, ...siblings };
    return inline(merged, root, depth + 1, new Set([...trail, ref]), budget);
  }
  const walk = (value: unknown) => inline(value, root, depth, trail, budget);
  const out: Json = {};
  for (const [key, value] of Object.entries(as2020(node))) {
    if (DROPPED.has(key)) continue;
    spend(budget, key.length + (LITERAL.has(key) ? (JSON.stringify(value)?.length ?? 0) : 0));
    out[key] = LITERAL.has(key)
      ? value
      : NAMED.has(key) && isObject(value)
        ? Object.fromEntries(
            Object.entries(value).map(([name, schema]) => {
              spend(budget, name.length);
              return [name, walk(schema)];
            }),
          )
        : Array.isArray(value)
          ? value.map(walk)
          : walk(value);
  }
  return out;
};

/**
 * A tool's input schema as the model is shown it: local references inlined,
 * meta keys dropped, always an object. Arguments are checked against the
 * server's own schema instead (`validationSchema`), so a detail lost here
 * never lets a wrong argument through. The reason, when it cannot be shown.
 */
export const normalizeSchema = (
  schema: unknown,
): { schema: JsonSchemaObject } | { error: string } => {
  if (schema === undefined) return { schema: { type: "object", properties: {} } };
  if (!isObject(schema)) return { error: "Its input schema is not an object." };
  let inlined: unknown;
  try {
    inlined = inline(schema, schema, 0, new Set(), { nodes: 0, chars: 0 });
  } catch (error) {
    if (error instanceof TooComplex) return { error: "Its input schema is too complex to offer." };
    throw error;
  }
  if (!isObject(inlined)) return { error: "Its input schema is not an object." };
  if (inlined.type !== undefined && inlined.type !== "object")
    return { error: "It does not take named arguments." };
  const normalized: Json = {
    ...inlined,
    type: "object",
    properties: isObject(inlined.properties) ? inlined.properties : {},
  };
  const text = JSON.stringify(normalized);
  if (text.length > MCP_LIMITS.schemaBytes)
    return { error: "Its input schema is too large to offer." };
  // A round trip through JSON is what makes it JSON, whatever the SDK handed over.
  return { schema: JSON.parse(text) as JsonSchemaObject };
};

/** One tool's schema can never fail the whole listing: whatever goes wrong refuses that tool. */
const normalizedOrRefused = (schema: unknown) => {
  try {
    return normalizeSchema(schema);
  } catch {
    return { error: "Its input schema could not be read." };
  }
};

const annotationsOf = (value: unknown): McpAnnotations => {
  if (!isObject(value)) return {};
  const flag = (key: string) => (typeof value[key] === "boolean" ? value[key] : undefined);
  return {
    ...(typeof value.title === "string" ? { title: value.title.slice(0, 120) } : {}),
    ...(flag("readOnlyHint") === undefined ? {} : { readOnlyHint: flag("readOnlyHint") }),
    ...(flag("destructiveHint") === undefined ? {} : { destructiveHint: flag("destructiveHint") }),
    ...(flag("idempotentHint") === undefined ? {} : { idempotentHint: flag("idempotentHint") }),
    ...(flag("openWorldHint") === undefined ? {} : { openWorldHint: flag("openWorldHint") }),
  } as McpAnnotations;
};

/** Stable JSON: object keys sorted, so a reordered schema is not a changed tool. */
const canonical = (value: unknown, depth = 0): string => {
  if (depth > MAX_NESTING) throw new TooComplex();
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
};

const fingerprintOf = (tool: Json) =>
  createHash("sha256")
    .update(
      canonical({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      }),
    )
    .digest("base64url")
    .slice(0, 22);

const humanTitle = (name: string) =>
  name
    .replace(/[_.-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/^./, (first) => first.toUpperCase());

/**
 * One listing as stored entries, in the server's order, at the access the
 * annotations claim. Keys stay what they were listed as before.
 */
export const listingEntries = (
  integrationId: string,
  tools: ReadonlyArray<unknown>,
  previous: ReadonlyArray<McpToolEntry>,
): McpToolEntry[] => {
  const valid = tools
    .filter(isObject)
    .filter((tool) => typeof tool.name === "string" && tool.name.length > 0)
    .slice(0, MCP_LIMITS.listedTools);
  const seen = new Set<string>();
  const unique = valid.filter((tool) => {
    const name = tool.name as string;
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
  const keys = assignKeys(
    integrationId,
    unique.map((tool) => tool.name as string),
    new Map(previous.map((entry) => [entry.mcpName, entry.key])),
  );
  return unique.map((tool): McpToolEntry => {
    const name = tool.name as string;
    const annotations = annotationsOf(tool.annotations);
    const key = keys.get(name)!;
    // Whatever goes wrong with one tool refuses that tool, never the listing.
    try {
      return entryOf(tool, name, key, annotations);
    } catch {
      return {
        key,
        mcpName: name,
        title: humanTitle(name).slice(0, 120),
        description: "",
        inputSchema: { type: "object", properties: {} },
        annotations,
        access: accessFromAnnotations(annotations),
        unsupported: "Its description could not be read.",
        fingerprint: createHash("sha256")
          .update(`unreadable:${name}`)
          .digest("base64url")
          .slice(0, 22),
      };
    }
  });
};

const entryOf = (
  tool: Json,
  name: string,
  key: string,
  annotations: McpAnnotations,
): McpToolEntry => {
  const fingerprint = fingerprintOf(tool);
  const shown = normalizedOrRefused(tool.inputSchema);
  const checked = validationSchema(tool.inputSchema);
  // Compiled now, so a tool whose arguments could never be checked is never offered.
  const check = "schema" in checked ? argumentCheck(fingerprint, checked.schema) : checked;
  const output = isObject(tool.outputSchema) ? normalizedOrRefused(tool.outputSchema) : null;
  const rawDescription = typeof tool.description === "string" ? tool.description.trim() : "";
  const title =
    (typeof tool.title === "string" && tool.title.trim()) || annotations.title || humanTitle(name);
  const unsupported = "error" in shown ? shown.error : "error" in check ? check.error : undefined;
  return {
    key,
    mcpName: name,
    title: title.slice(0, 120),
    // Cut, not refused: a long description is no reason to lose the tool, and its start says what it is.
    description:
      rawDescription.length > MCP_LIMITS.descriptionChars
        ? `${rawDescription.slice(0, MCP_LIMITS.descriptionChars - 1)}…`
        : rawDescription,
    inputSchema: "schema" in shown ? shown.schema : { type: "object", properties: {} },
    ...("schema" in checked ? { validation: checked.schema } : {}),
    ...(output && "schema" in output ? { outputSchema: output.schema } : {}),
    annotations,
    access: accessFromAnnotations(annotations),
    ...(unsupported ? { unsupported } : {}),
    fingerprint,
  };
};
