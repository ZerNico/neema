import { createHash } from "node:crypto";
import {
  accessFromAnnotations,
  assignKeys,
  MCP_LIMITS,
  type JsonSchemaObject,
  type McpAnnotations,
  type McpToolEntry,
} from "../catalog.ts";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Keys a provider has no use for, or that would point at definitions we inline. */
const DROPPED = new Set(["$schema", "$id", "$defs", "definitions", "$comment"]);

/** Inlining stops here; deeper (or recursive) references become an open schema. */
const MAX_DEPTH = 8;
/**
 * Nodes one schema may expand to. A few references that each name the next
 * twice multiply past any size check, so expansion stops counting here.
 */
const MAX_NODES = 5_000;

class TooComplex extends Error {}

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

const inline = (
  node: unknown,
  root: Json,
  depth: number,
  trail: ReadonlySet<string>,
  budget: { nodes: number },
): unknown => {
  if (++budget.nodes > MAX_NODES) throw new TooComplex();
  if (Array.isArray(node)) return node.map((item) => inline(item, root, depth, trail, budget));
  if (!isObject(node)) return node;
  const ref = typeof node.$ref === "string" ? node.$ref : null;
  if (ref) {
    const target = resolvePointer(root, ref);
    // A remote, missing or recursive reference accepts anything: the server
    // still validates the call, and the model is not handed a dangling pointer.
    if (!isObject(target) || trail.has(ref) || depth >= MAX_DEPTH) {
      const { $ref: _ref, ...rest } = node;
      return inline(rest, root, depth, trail, budget);
    }
    const { $ref: _ref, ...siblings } = node;
    return inline({ ...target, ...siblings }, root, depth + 1, new Set([...trail, ref]), budget);
  }
  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (DROPPED.has(key)) continue;
    out[key] = inline(value, root, depth, trail, budget);
  }
  return out;
};

/**
 * A tool's input schema made safe to hand any provider: local references
 * inlined, meta keys dropped, always an object. Null, with the reason, when
 * it cannot be offered as written.
 */
export const normalizeSchema = (
  schema: unknown,
): { schema: JsonSchemaObject } | { error: string } => {
  if (schema === undefined) return { schema: { type: "object", properties: {} } };
  if (!isObject(schema)) return { error: "Its input schema is not an object." };
  let inlined: unknown;
  try {
    inlined = inline(schema, schema, 0, new Set(), { nodes: 0 });
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
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
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
 * One listing as stored entries, in the server's order, unreviewed: off, at
 * the access the annotations claim. Keys stay what they were approved as.
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
    const input = normalizeSchema(tool.inputSchema);
    const output = isObject(tool.outputSchema) ? normalizeSchema(tool.outputSchema) : null;
    const rawDescription = typeof tool.description === "string" ? tool.description.trim() : "";
    const title =
      (typeof tool.title === "string" && tool.title.trim()) ||
      annotations.title ||
      humanTitle(name);
    const unsupported =
      "error" in input
        ? input.error
        : rawDescription.length > MCP_LIMITS.descriptionChars
          ? `Its description is longer than ${MCP_LIMITS.descriptionChars} characters.`
          : undefined;
    return {
      key: keys.get(name)!,
      mcpName: name,
      title: title.slice(0, 120),
      description: rawDescription.slice(0, MCP_LIMITS.descriptionChars),
      inputSchema: "schema" in input ? input.schema : { type: "object", properties: {} },
      ...(output && "schema" in output ? { outputSchema: output.schema } : {}),
      annotations,
      access: accessFromAnnotations(annotations),
      enabled: false,
      ...(unsupported ? { unsupported } : {}),
      fingerprint: fingerprintOf(tool),
    };
  });
};
