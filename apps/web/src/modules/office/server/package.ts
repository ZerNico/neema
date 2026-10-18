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

/** An Office package's parts by name, inflated once and read by every later pass. */
export type PackageParts = Record<string, Uint8Array>;

/**
 * Macros, ActiveX controls and OLE objects, which no format carries: by part
 * name and by declared content type, before any parser reads the package.
 */
function activeContent(names: readonly string[], types: string) {
  if (
    names.some((name) => /(^|\/)vbaproject\.bin$/i.test(name)) ||
    /macroEnabled|vbaProject/i.test(types)
  )
    return "macros";
  if (
    names.some((name) => /(^|\/)activex\//i.test(name) || /(^|\/)oleobject\d*\.bin$/i.test(name)) ||
    /activeX|oleObject/i.test(types)
  )
    return "objects";
  return null;
}

/**
 * Reads an Office package through the one bounded ZIP reader, so every format
 * gets the same checks: real inflated sizes, expansion ratio, checksums,
 * consistent headers, safe part names and no active content. `fail` names the
 * kind of refusal; without `accept` the parts are only checked.
 */
export function readOfficePackage(
  bytes: Uint8Array,
  options: {
    readonly limits: ZipLimits;
    readonly fail: (
      kind: "entries" | "size" | "invalid" | "macros" | "objects",
      message: string,
    ) => never;
    readonly accept?: (name: string, bytes: Uint8Array) => void;
  },
): string[] {
  const names: string[] = [];
  let types = "";
  readZip(bytes, {
    limits: options.limits,
    fail: (message, _name, limit) => options.fail(limit ?? "invalid", message),
    checkName: (name) => {
      if (unsafePartName(name)) options.fail("invalid", "Unsafe ZIP entry name.");
    },
    accept: (name, data) => {
      names.push(name);
      if (name === "[Content_Types].xml") types = new TextDecoder().decode(data);
      options.accept?.(name, data);
    },
    crc32,
  });
  const active = activeContent(names, types);
  if (active === "macros") options.fail(active, "Macro-enabled files are unsupported.");
  if (active === "objects") options.fail(active, "Embedded objects and controls are unsupported.");
  return names;
}
