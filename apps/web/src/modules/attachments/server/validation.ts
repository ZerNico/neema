import { Effect } from "effect";
import {
  MAX_ATTACHMENT_BYTES,
  PDF_MEDIA_TYPE,
  TEXT_MEDIA_TYPE,
  attachmentKind,
  fileExtension,
  fileMediaType,
  isTextExtension,
  textLanguage,
} from "../constants.ts";
import type { AttachmentKind } from "../constants.ts";
import { AttachmentRejected } from "../errors.ts";

const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>, offset = 0): boolean =>
  bytes.length >= offset + signature.length &&
  signature.every((byte, i) => bytes[offset + i] === byte);

const ascii = (text: string): ReadonlyArray<number> => [...text].map((c) => c.charCodeAt(0));

// PDFs in the wild sometimes carry leading junk before the header; pdf.js
// tolerates it within the first kilobyte, so we do too.
const PDF_HEADER_SCAN_BYTES = 1024;

const hasPdfHeader = (bytes: Uint8Array): boolean => {
  const header = ascii("%PDF-");
  const limit = Math.min(bytes.length, PDF_HEADER_SCAN_BYTES);
  for (let i = 0; i + header.length <= limit; i++) {
    if (startsWith(bytes, header, i)) return true;
  }
  return false;
};

/**
 * Identifies a binary attachment from its leading bytes. The browser-supplied
 * Content-Type is never trusted: a `.png` full of HTML must not be stored as an
 * image, and a spoofed type would otherwise pick the serving headers.
 */
export const sniffBinaryMediaType = (bytes: Uint8Array): string | null => {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "image/gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  if (hasPdfHeader(bytes)) return PDF_MEDIA_TYPE;
  return null;
};

const isControlCode = (code: number): boolean => code < 0x20 || code === 0x7f;

/** Strips directory components and control characters; caps the length. */
export const sanitizeFileName = (raw: string): string => {
  const base = raw.split(/[/\\]/).pop() ?? "";
  const cleaned = [...base]
    .filter((char) => !isControlCode(char.charCodeAt(0)))
    .join("")
    .trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "file";
  if (cleaned.length <= 200) return cleaned;
  const ext = fileExtension(cleaned);
  return ext === "" ? cleaned.slice(0, 200) : `${cleaned.slice(0, 200 - ext.length - 1)}.${ext}`;
};

const isValidUtf8 = (bytes: Uint8Array): boolean => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // A NUL byte decodes fine but means the file is not really text.
    return !text.includes(String.fromCharCode(0));
  } catch {
    return false;
  }
};

export interface ValidatedAttachment {
  fileName: string;
  mediaType: string;
  kind: AttachmentKind;
}

/**
 * What a file is, from its bytes: an image or PDF by signature, text when it
 * decodes as UTF-8 and claims to be text, and otherwise an opaque file. Never
 * refuses; size and emptiness are the caller's rules.
 */
export const classifyFile = (
  fileName: string,
  declaredMediaType: string,
  bytes: Uint8Array,
): ValidatedAttachment => {
  const sniffed = sniffBinaryMediaType(bytes);
  if (sniffed !== null) return { fileName, mediaType: sniffed, kind: attachmentKind(sniffed) };
  const ext = fileExtension(fileName);
  const looksTextual = ext === "" || isTextExtension(ext) || declaredMediaType.startsWith("text/");
  if (looksTextual && isValidUtf8(bytes))
    return { fileName, mediaType: TEXT_MEDIA_TYPE, kind: "text" };
  // Kept as an opaque file: downloadable, readable by tools, and described to
  // the model rather than shown to it.
  return { fileName, mediaType: fileMediaType(fileName), kind: "file" };
};

/**
 * Decides what an uploaded file actually is, from its bytes. Text files keep no
 * trace of their declared type; everything textual is normalized to
 * text/plain so serving headers are uniform.
 */
export const validateAttachment = Effect.fn("attachments.validateAttachment")(function* (input: {
  fileName: string;
  declaredMediaType: string;
  bytes: Uint8Array;
}) {
  const fileName = sanitizeFileName(input.fileName);

  if (input.bytes.length === 0) {
    return yield* new AttachmentRejected({ cause: "content", reason: "The file is empty." });
  }
  if (input.bytes.length > MAX_ATTACHMENT_BYTES) {
    return yield* new AttachmentRejected({
      cause: "size",
      reason: `Files must be ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB or smaller.`,
    });
  }

  return classifyFile(fileName, input.declaredMediaType, input.bytes);
});

/**
 * Wraps attachment text in a fence the model can't be confused by: longer than
 * any backtick run inside the content, labelled with the file name.
 */
export const buildTextFence = (input: {
  fileName: string;
  text: string;
  label?: string;
}): string => {
  const longestRun = [...input.text.matchAll(/`+/g)].reduce(
    (max, match) => Math.max(max, match[0].length),
    0,
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const language = textLanguage(input.fileName);
  const body = input.text.endsWith("\n") ? input.text.slice(0, -1) : input.text;
  return `${input.label ?? "Attached file"}: ${input.fileName}\n${fence}${language}\n${body}\n${fence}`;
};
