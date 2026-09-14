import { LIMITS } from "@chat/desktop-rpc";
import { IMAGE_MEDIA_TYPES, PDF_MEDIA_TYPE } from "~/modules/attachments/constants.ts";
import { sniffBinaryMediaType, sanitizeFileName } from "~/modules/attachments/server/validation.ts";
import {
  DESKTOP_RESULT_DETAIL_CHARS,
  desktopFailure,
  type DesktopToolResult,
} from "../tool-schema.ts";

const SUMMARY_CHARS = 1_024;
const VIOLATION_CHARS = 500;
const VIOLATIONS = 32;
const NAME_CHARS = 200;
/** Base64 of `LIMITS.binaryBytes`, plus padding. Checked before decode. */
const MAX_FILE_BASE64 = Math.ceil((LIMITS.binaryBytes * 4) / 3) + 4;

const ALLOWED_FILE_TYPES: ReadonlySet<string> = new Set([...IMAGE_MEDIA_TYPES, PDF_MEDIA_TYPE]);

const storable = (text: string) => text.replaceAll("\u0000", "");

const acceptFile = (
  file: NonNullable<DesktopToolResult["file"]>,
): NonNullable<DesktopToolResult["file"]> | undefined => {
  if (file.base64.length > MAX_FILE_BASE64 || file.base64.length % 4 !== 0) return undefined;
  const bytes = Buffer.from(file.base64, "base64");
  if (bytes.length === 0 || bytes.length > LIMITS.binaryBytes) return undefined;
  const mediaType = sniffBinaryMediaType(bytes);
  if (mediaType === null || mediaType !== file.mediaType || !ALLOWED_FILE_TYPES.has(mediaType))
    return undefined;
  const name = sanitizeFileName(file.name).slice(0, NAME_CHARS);
  return { mediaType, base64: file.base64, name };
};

/**
 * The page is an untrusted hop. Cap strings, drop a file that is not a sniffed
 * image or PDF, and never `Buffer.from` an oversized payload.
 */
export const acceptDesktopToolResult = (result: DesktopToolResult): DesktopToolResult => {
  const summary = storable(result.summary).slice(0, SUMMARY_CHARS);
  const detail = storable(result.detail).slice(0, DESKTOP_RESULT_DETAIL_CHARS);
  const violations = (result.violations ?? [])
    .map((item) => storable(item).slice(0, VIOLATION_CHARS))
    .filter((item) => item !== "")
    .slice(0, VIOLATIONS);
  const file = result.file ? acceptFile(result.file) : undefined;
  if (result.file && !file)
    return desktopFailure(
      "That file could not be sent",
      "The file was not a usable image or PDF, or it was too large.",
    );
  return {
    v: 1,
    ok: result.ok,
    summary: summary === "" ? "Done" : summary,
    detail,
    truncated:
      result.truncated ||
      result.summary.length > SUMMARY_CHARS ||
      result.detail.length > DESKTOP_RESULT_DETAIL_CHARS,
    ...(violations.length > 0 ? { violations } : {}),
    ...(file ? { file } : {}),
  };
};
