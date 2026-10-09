import type { JsonValue } from "~/db/schema/providers.ts";
import type { ToolAccess } from "../manifest.ts";

/** A JSON Schema as the server sent it, which is JSON by construction. */
export type JsonSchemaObject = { readonly [key: string]: JsonValue };

/** What a server says about a tool's behaviour; hints only, until an admin confirms them. */
export interface McpAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

/**
 * One tool of an MCP server as stored: everything the server said, made safe
 * to offer, plus the admin's decisions once reviewed. The server's own parts
 * are covered by `fingerprint`, so a changed description or schema is a
 * different tool until someone approves it.
 */
export interface McpToolEntry {
  /** The model-facing suffix after `int_<integration>__`; kept for the tool's lifetime. */
  readonly key: string;
  /** What the server calls it. */
  readonly mcpName: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
  readonly outputSchema?: JsonSchemaObject;
  readonly annotations: McpAnnotations;
  /** Read from the annotations, or what the admin chose. */
  readonly access: ToolAccess;
  /** The admin chose `access` rather than taking the annotations' word. */
  readonly accessChosen?: boolean;
  readonly enabled: boolean;
  /** Why it can never be offered as the server describes it. */
  readonly unsupported?: string;
  readonly fingerprint: string;
}

export const MCP_LIMITS = {
  descriptionChars: 2_000,
  schemaBytes: 32_000,
  /** Offered at most; the admin turns off the rest. */
  enabledTools: 64,
  listedTools: 500,
  resultChars: 40_000,
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
 * Model-safe keys for a listing. A tool keeps the key it was approved under,
 * so renaming nothing on the server never renames anything for the model;
 * new ones are cleaned, cut to fit and tagged when they would collide.
 */
export const assignKeys = (
  integrationId: string,
  names: ReadonlyArray<string>,
  previous: ReadonlyMap<string, string>,
) => {
  const budget = keyBudget(integrationId);
  const taken = new Set<string>();
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

export type CatalogChange =
  | { readonly kind: "added"; readonly entry: McpToolEntry }
  | { readonly kind: "changed"; readonly entry: McpToolEntry; readonly before: McpToolEntry }
  | { readonly kind: "removed"; readonly before: McpToolEntry }
  | { readonly kind: "unchanged"; readonly entry: McpToolEntry; readonly before: McpToolEntry };

/** What the server lists now against what was approved, in the server's order. */
export const diffCatalog = (
  approved: ReadonlyArray<McpToolEntry>,
  latest: ReadonlyArray<McpToolEntry> | null,
): CatalogChange[] => {
  if (latest === null)
    return approved.map((entry) => ({ kind: "unchanged", entry, before: entry }));
  const before = new Map(approved.map((entry) => [entry.mcpName, entry]));
  const now = new Set(latest.map((entry) => entry.mcpName));
  const changes: CatalogChange[] = latest.map((entry) => {
    const old = before.get(entry.mcpName);
    if (!old) return { kind: "added", entry };
    return old.fingerprint === entry.fingerprint
      ? { kind: "unchanged", entry, before: old }
      : { kind: "changed", entry, before: old };
  });
  for (const old of approved)
    if (!now.has(old.mcpName)) changes.push({ kind: "removed", before: old });
  return changes;
};

/** Whether anything waits for the admin: a tool new, changed or gone since approval. */
export const hasPendingChanges = (
  approved: ReadonlyArray<McpToolEntry>,
  latest: ReadonlyArray<McpToolEntry> | null,
) => diffCatalog(approved, latest).some((change) => change.kind !== "unchanged");

/**
 * What a generation may offer: approved, enabled, supported, and still what
 * the server lists. A tool changed since approval waits for review rather
 * than running under a description nobody read; one the server dropped is
 * gone at once, the safe direction.
 */
export const offeredEntries = (
  approved: ReadonlyArray<McpToolEntry>,
  latest: ReadonlyArray<McpToolEntry> | null,
) => {
  const current = latest ? new Map(latest.map((entry) => [entry.mcpName, entry])) : null;
  return approved.filter(
    (entry) =>
      entry.enabled &&
      !entry.unsupported &&
      (current === null || current.get(entry.mcpName)?.fingerprint === entry.fingerprint),
  );
};

/** The admin's decision on one listed tool. */
export interface CatalogDecision {
  readonly mcpName: string;
  readonly enabled: boolean;
  readonly access: ToolAccess;
}

/**
 * The catalog after a review: exactly what the server lists now, in its
 * order, with the admin's decisions applied. A tool the admin left out of
 * the decisions keeps its earlier choice, or comes in off.
 */
export const applyDecisions = (
  approved: ReadonlyArray<McpToolEntry>,
  latest: ReadonlyArray<McpToolEntry>,
  decisions: ReadonlyArray<CatalogDecision>,
): McpToolEntry[] => {
  const byName = new Map(decisions.map((decision) => [decision.mcpName, decision]));
  const before = new Map(approved.map((entry) => [entry.mcpName, entry]));
  return latest.map((entry) => {
    const decision = byName.get(entry.mcpName);
    const old = before.get(entry.mcpName);
    const enabled = !entry.unsupported && (decision?.enabled ?? old?.enabled ?? false);
    const access = decision?.access ?? (old?.accessChosen ? old.access : entry.access);
    return {
      ...entry,
      enabled,
      access,
      ...(access !== entry.access || old?.accessChosen ? { accessChosen: true } : {}),
    };
  });
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

/** One line from the first few short arguments, since a catalog tool has no summary of its own. */
export const summarizeArguments = (args: unknown) => {
  const parts = argumentDetails(args)
    .filter((entry) => entry.value.length > 0)
    .slice(0, 3)
    .map((entry) => `${entry.key}: ${briefValue(entry.value, 60)}`);
  return parts.length ? briefValue(parts.join(" · "), 200) : null;
};
