import { readOfficePackage } from "../../office/server/package.ts";
import { PresentationError } from "../errors.ts";
import { PRESENTATION_LIMITS } from "../limits.ts";

/** Every part of a PPTX within the package limits, keyed by its slash-free part name. */
export function readPresentationArchive(bytes: Uint8Array): Map<string, Uint8Array> {
  const parts = new Map<string, Uint8Array>();
  readOfficePackage(bytes, {
    limits: {
      archiveBytes: PRESENTATION_LIMITS.compressedBytes,
      entries: PRESENTATION_LIMITS.entries,
      entryBytes: PRESENTATION_LIMITS.expandedBytes,
      expandedBytes: PRESENTATION_LIMITS.expandedBytes,
      expansionRatio: PRESENTATION_LIMITS.expansionRatio,
    },
    fail: (_kind, message) => {
      throw new PresentationError("invalid_package", message);
    },
    accept: (name, data) => parts.set(name, data),
  });
  return parts;
}
