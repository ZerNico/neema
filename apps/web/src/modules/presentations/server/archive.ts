import { crc32 } from "node:zlib";
import { readZip } from "../../attachments/zip.ts";
import { PresentationError } from "../errors.ts";
import { PRESENTATION_LIMITS } from "../limits.ts";

const invalid = (message: string): never => {
  throw new PresentationError("invalid_package", message);
};
const safeName = (name: string) => {
  if (
    name.length === 0 ||
    name.length > 240 ||
    name.startsWith("/") ||
    /[\\%]/.test(name) ||
    [...name].some((character) => character.charCodeAt(0) < 32) ||
    name.split("/").some((segment) => segment === "." || segment === ".." || segment.length === 0)
  )
    invalid("Unsafe ZIP entry name.");
};

/** Every part of a PPTX within the package limits, keyed by its slash-free part name. */
export function readPresentationArchive(bytes: Uint8Array): Map<string, Uint8Array> {
  return readZip(bytes, {
    limits: {
      archiveBytes: PRESENTATION_LIMITS.compressedBytes,
      entries: PRESENTATION_LIMITS.entries,
      entryBytes: PRESENTATION_LIMITS.expandedBytes,
      expandedBytes: PRESENTATION_LIMITS.expandedBytes,
      expansionRatio: PRESENTATION_LIMITS.expansionRatio,
    },
    fail: invalid,
    checkName: safeName,
    crc32,
  });
}
