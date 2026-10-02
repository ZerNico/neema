import { createHash } from "node:crypto";
import type { JsonValue } from "~/db/schema/providers.ts";

/** Text longer than this is content the call wrote, stored where it produced it. */
const TEXT_CHARS = 400;
const ARRAY_ITEMS = 40;
const DEPTH = 8;
/** The whole stored copy; past it only the argument names are kept. */
const STORED_CHARS = 4096;
/** A failed call's full arguments, kept a week for debugging. */
const DEBUG_CHARS = 64 * 1024;

// Any long string is omitted anyway; a data URL is named as bytes so a reader
// does not mistake an image for text the model wrote.
const DATA_URL = /^data:[\w.+/-]+;base64,/;

const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

function trimmed(value: unknown, depth: number): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (DATA_URL.test(value)) return { $omitted: "bytes", chars: value.length };
    return value.length > TEXT_CHARS
      ? { $omitted: "text", chars: value.length, sha256: digest(value) }
      : value;
  }
  if (value instanceof Uint8Array) return { $omitted: "bytes", bytes: value.length };
  if (depth >= DEPTH) return { $omitted: "nested" };
  if (Array.isArray(value)) {
    const kept = value.slice(0, ARRAY_ITEMS).map((item) => trimmed(item, depth + 1));
    return value.length > ARRAY_ITEMS
      ? [...kept, { $omitted: "items", count: value.length - ARRAY_ITEMS }]
      : kept;
  }
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, trimmed(item, depth + 1)]),
    );
  return null;
}

/**
 * What a call's arguments look like in its stored row: every short field as
 * the model wrote it, so a resumed answer and a person debugging see what was
 * done, and content (file text, slide text, image data) as its size and hash.
 * That content already lives in what the call produced; storing it here too
 * would keep a second copy.
 */
export function storedArguments(args: unknown): JsonValue {
  const value = trimmed(args, 0);
  const text = JSON.stringify(value);
  if (text.length <= STORED_CHARS) return value;
  return {
    $omitted: "arguments",
    chars: text.length,
    keys: args && typeof args === "object" ? Object.keys(args).slice(0, 40) : [],
  };
}

/** A failed call's arguments in full, up to a cap; past it, the stored copy instead. */
export function debugArguments(args: unknown): JsonValue {
  const text = JSON.stringify(args, (_key, value: unknown) =>
    value instanceof Uint8Array ? { $omitted: "bytes", bytes: value.length } : value,
  );
  if (text === undefined) return null;
  return text.length <= DEBUG_CHARS ? (JSON.parse(text) as JsonValue) : storedArguments(args);
}
