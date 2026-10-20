import type { JsonValue } from "~/db/schema/providers.ts";
import type { ToolAccess } from "../manifest.ts";

/** A JSON Schema as the server sent it, which is JSON by construction. */
export type JsonSchemaObject = { readonly [key: string]: JsonValue };

/** What a server says about a tool's behaviour; an admin may correct the access it implies. */
export interface McpAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

/**
 * One tool of an MCP server as listed: everything the server said, made safe
 * to offer. The server's own parts are covered by `fingerprint`, so a call
 * prepared against one version never goes out under another.
 */
export interface McpToolEntry {
  /** The model-facing suffix after `int_<integration>__`; kept for the tool's lifetime. */
  readonly key: string;
  /** What the server calls it. */
  readonly mcpName: string;
  readonly title: string;
  readonly description: string;
  /** What the model is shown: references inlined, one dialect, always an object. */
  readonly inputSchema: JsonSchemaObject;
  /**
   * What arguments are checked against: the server's own schema, only made
   * safe to check. Absent in entries listed before it was kept.
   */
  readonly validation?: JsonSchemaObject;
  /** Only whether there is one matters: results are never checked against it. */
  readonly outputSchema?: JsonSchemaObject;
  readonly annotations: McpAnnotations;
  /** Read from the annotations; the admin's tool settings may correct it. */
  readonly access: ToolAccess;
  /** Why it can never be offered as the server describes it. */
  readonly unsupported?: string;
  readonly fingerprint: string;
}

export const MCP_LIMITS = {
  descriptionChars: 2_000,
  schemaBytes: 32_000,
  /** Offered at most, in the server's order; the admin turns off the rest. */
  enabledTools: 64,
  listedTools: 500,
  resultChars: 40_000,
  /** Citable links from one result; more stay out of the model's context. */
  sources: 20,
  urlChars: 2_000,
  files: 8,
  fileBytes: 10 * 1024 * 1024,
  elicitationRounds: 5,
} as const;

/**
 * Hints are untrusted, so a tool that says nothing is the most dangerous kind
 * (the spec's defaults): it asks every time and never runs in a schedule.
 */
export const accessFromAnnotations = (annotations: McpAnnotations): ToolAccess =>
  annotations.readOnlyHint === true
    ? "read"
    : annotations.destructiveHint === false
      ? "write"
      : "destructive";

const sanitize = (name: string) =>
  name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "tool";

/** A short stable tag from a string, so two names that clean up alike stay apart. */
const tag = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 5);
};

/** How long a key may be for this integration: `int_<id>__<key>` is at most 64. */
export const keyBudget = (integrationId: string) => 64 - `int_${integrationId}__`.length;

/**
 * Model-safe keys for a listing. A tool keeps the key it was first listed
 * under, by any account, so renaming nothing on the server never renames
 * anything for the model; new ones are cleaned, cut to fit and tagged when
 * they would collide.
 */
export const assignKeys = (
  integrationId: string,
  names: ReadonlyArray<string>,
  previous: ReadonlyMap<string, string>,
) => {
  const budget = keyBudget(integrationId);
  // A key another tool holds stays its own, even one this listing does not name:
  // another account's listing of the same server may still offer it.
  const listed = new Set(names);
  const taken = new Set([...previous].flatMap(([name, key]) => (listed.has(name) ? [] : [key])));
  const keys = new Map<string, string>();
  for (const name of names) {
    const kept = previous.get(name);
    if (kept && !taken.has(kept)) {
      keys.set(name, kept);
      taken.add(kept);
    }
  }
  for (const name of names) {
    if (keys.has(name)) continue;
    const clean = sanitize(name);
    let key = clean;
    // Only a cut or a clash is tagged; a name that fits keeps its own spelling.
    for (let attempt = 0; key.length > budget || taken.has(key); attempt++) {
      const suffix = `_${tag(attempt ? `${name}#${attempt}` : name)}`;
      key = `${clean.slice(0, budget - suffix.length)}${suffix}`;
    }
    taken.add(key);
    keys.set(name, key);
  }
  return keys;
};

/** A JSON value in one short line, for an approval card or a summary. */
export const briefValue = (value: unknown, max: number) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/** The arguments as an approval card lists them, every one, each bounded. */
export const argumentDetails = (args: unknown) => {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  return Object.entries(args as Record<string, unknown>)
    .slice(0, 20)
    .map(([key, value]) => ({ key: key.slice(0, 64), value: briefValue(value, 300) }));
};

/** Above this, a call's arguments cannot be put to a person to approve. */
export const REVIEWABLE_CHARS = 100_000;

/**
 * Every argument as sent, for an approval the short list cannot cover: more
 * arguments than it shows, or a value it shortened or flattened. Null when
 * the list already shows everything.
 */
export const argumentsInFull = (args: unknown) => {
  const entries =
    args && typeof args === "object" && !Array.isArray(args)
      ? Object.entries(args as Record<string, unknown>)
      : null;
  const listed =
    entries !== null &&
    entries.length <= 20 &&
    entries.every(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return key.length <= 64 && briefValue(value, 300) === (text ?? "");
    });
  return listed ? null : JSON.stringify(args ?? {}, null, 2);
};

/** One line from the first few short arguments, since a catalog tool has no summary of its own. */
export const summarizeArguments = (args: unknown) => {
  const parts = argumentDetails(args)
    .filter((entry) => entry.value.length > 0)
    .slice(0, 3)
    .map((entry) => `${entry.key}: ${briefValue(entry.value, 60)}`);
  return parts.length ? briefValue(parts.join(" · "), 200) : null;
};
