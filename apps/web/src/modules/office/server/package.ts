// Worker processes load this file without the `~` alias; keep imports relative.
import { crc32 } from "node:zlib";
import { readZip, type ZipLimits } from "../../attachments/zip.ts";

/**
 * Part names an Office package may use: relative paths of ordinary segments.
 * Anything else is a path a careless extractor would follow out of place.
 */
export const unsafePartName = (name: string) =>
  name.length === 0 ||
  name.length > 240 ||
  name.startsWith("/") ||
  /[\\%]/.test(name) ||
  [...name].some((character) => character.charCodeAt(0) < 32) ||
  name.split("/").some((segment) => segment === "." || segment === ".." || segment.length === 0);

/**
 * Reads an Office package through the one bounded ZIP reader, so every format
 * gets the same checks: real inflated sizes, expansion ratio, checksums,
 * consistent headers and safe part names. `fail` names the kind of refusal;
 * without `accept` the parts are only checked.
 */
export function readOfficePackage(
  bytes: Uint8Array,
  options: {
    readonly limits: ZipLimits;
    readonly fail: (kind: "entries" | "size" | "invalid", message: string) => never;
    readonly accept?: (name: string, bytes: Uint8Array) => void;
  },
): string[] {
  const names: string[] = [];
  readZip(bytes, {
    limits: options.limits,
    fail: (message, _name, limit) => options.fail(limit ?? "invalid", message),
    checkName: (name) => {
      if (unsafePartName(name)) options.fail("invalid", "Unsafe ZIP entry name.");
    },
    accept: (name, data) => {
      names.push(name);
      options.accept?.(name, data);
    },
    crc32,
  });
  return names;
}
