// Shared attachment limits and type allowlists. Imported by both the client
// (chip UI, paste handling, file picker) and the server (validation), so this
// module must stay free of node/browser-only imports.

import { LIMITS } from "@chat/desktop-rpc/schema";
import { baseLocale, type Locale } from "~/paraglide/runtime.js";

/**
 * One bound for a whole file anywhere: an attachment, a working draft, a file
 * the desktop reads or saves. The subpath brings in the limits, not the RPC group.
 */
export const MAX_ATTACHMENT_BYTES = LIMITS.binaryBytes;
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

/** Pasting more than this becomes a text attachment instead of draft text. */
export const PASTE_TEXT_CHAR_THRESHOLD = 2_000;
export const PASTE_TEXT_LINE_THRESHOLD = 50;
export const PASTED_TEXT_FILE_NAME = "pasted-text.txt";

/**
 * No SVG: it is active content (scripts, external refs) and we serve blobs
 * from our own origin.
 */
export const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export const PDF_MEDIA_TYPE = "application/pdf";
export const TEXT_MEDIA_TYPE = "text/plain";

/** Anything that is none of the others: kept and downloadable, never shown inline. */
export const GENERIC_MEDIA_TYPE = "application/octet-stream";
export const PPTX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export const XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const DOCX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export type AttachmentKind = "image" | "pdf" | "text" | "file";

/**
 * Extensions accepted as text attachments; anything else must sniff as an
 * image or PDF. Keyed to a markdown language hint for the prompt fence.
 */
export const TEXT_EXTENSIONS: Record<string, string> = {
  bash: "bash",
  c: "c",
  cfg: "ini",
  conf: "ini",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  csv: "csv",
  diff: "diff",
  go: "go",
  h: "c",
  hpp: "cpp",
  htm: "html",
  html: "html",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "jsx",
  kt: "kotlin",
  log: "",
  lua: "lua",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  mjs: "javascript",
  patch: "diff",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  svelte: "svelte",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsv: "tsv",
  tsx: "tsx",
  txt: "",
  vue: "vue",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

export const fileExtension = (fileName: string): string => {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return "";
  return fileName.slice(dot + 1).toLowerCase();
};

/** True when the extension is on the text allowlist. Own-property check,
 * since a file named `x.constructor` must not match via the prototype chain. */
export const isTextExtension = (ext: string): boolean => Object.hasOwn(TEXT_EXTENSIONS, ext);

/** Markdown language hint for a text attachment; "" when we have none. */
export const textLanguage = (fileName: string): string => {
  const ext = fileExtension(fileName);
  return isTextExtension(ext) ? TEXT_EXTENSIONS[ext]! : "";
};

/**
 * Only the exact types a model and the preview understand count as images,
 * PDFs or text; every other stored type, `image/heic` included, is a file.
 */
export const attachmentKind = (mediaType: string): AttachmentKind =>
  (IMAGE_MEDIA_TYPES as ReadonlyArray<string>).includes(mediaType)
    ? "image"
    : mediaType === PDF_MEDIA_TYPE
      ? "pdf"
      : mediaType === TEXT_MEDIA_TYPE
        ? "text"
        : "file";

/**
 * Descriptive types for common files, for tools and downloads. Informational
 * only: a file is always served as a download, whatever this says.
 */
const FILE_MEDIA_TYPES: Record<string, string> = {
  "7z": "application/x-7z-compressed",
  avif: "image/avif",
  bmp: "image/bmp",
  docx: DOCX_MEDIA_TYPE,
  epub: "application/epub+zip",
  gz: "application/gzip",
  heic: "image/heic",
  ico: "image/vnd.microsoft.icon",
  key: "application/vnd.apple.keynote",
  m4a: "audio/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  otf: "font/otf",
  odp: "application/vnd.oasis.opendocument.presentation",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odt: "application/vnd.oasis.opendocument.text",
  ogg: "audio/ogg",
  pptx: PPTX_MEDIA_TYPE,
  rtf: "application/rtf",
  svg: "image/svg+xml",
  tar: "application/x-tar",
  tif: "image/tiff",
  tiff: "image/tiff",
  ttf: "font/ttf",
  wav: "audio/wav",
  webm: "video/webm",
  woff: "font/woff",
  woff2: "font/woff2",
  xlsx: XLSX_MEDIA_TYPE,
  zip: "application/zip",
};

/** The media type a file of this name is stored with; never one of the readable kinds. */
export const fileMediaType = (fileName: string): string => {
  const extension = fileExtension(fileName);
  const known = Object.hasOwn(FILE_MEDIA_TYPES, extension) ? FILE_MEDIA_TYPES[extension]! : null;
  return known && attachmentKind(known) === "file" ? known : GENERIC_MEDIA_TYPE;
};

/** Best-effort display kind for local files whose MIME type was never uploaded. */
export const attachmentKindForFileName = (fileName: string): AttachmentKind => {
  const extension = fileExtension(fileName);
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(extension)) return "image";
  if (extension === "pdf") return "pdf";
  return isTextExtension(extension) ? "text" : "file";
};

/**
 * A size for reading. English by default, which is what the model reads; a page
 * passes `getLocale()` so a German reader sees a decimal comma.
 */
export const formatFileSize = (bytes: number, locale: Locale = baseLocale): string => {
  const number = (value: number, digits: number) =>
    new Intl.NumberFormat(locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      useGrouping: false,
    }).format(value);
  if (bytes < 1024) return `${number(bytes, 0)} B`;
  if (bytes < 1024 * 1024) return `${number(Math.round(bytes / 1024), 0)} KB`;
  return `${number(bytes / (1024 * 1024), 1)} MB`;
};
