// Shared attachment limits and type allowlists. Imported by both the client
// (chip UI, paste handling, file picker) and the server (validation), so this
// module must stay free of node/browser-only imports.

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

// Pasting more than this becomes a text attachment instead of draft text.
export const PASTE_TEXT_CHAR_THRESHOLD = 2_000;
export const PASTE_TEXT_LINE_THRESHOLD = 50;
export const PASTED_TEXT_FILE_NAME = "pasted-text.txt";

// No SVG: it is active content (scripts, external refs) and we serve blobs
// from our own origin.
export const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export const PDF_MEDIA_TYPE = "application/pdf";
export const TEXT_MEDIA_TYPE = "text/plain";

export type AttachmentKind = "image" | "pdf" | "text";

// Extensions accepted as text attachments; anything else must sniff as an
// image or PDF. Keyed to a markdown language hint for the prompt fence.
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

// `accept` for the hidden file input. Extensions carry the text types because
// browsers report inconsistent MIME types for source files.
export const ATTACHMENT_ACCEPT = [
  ...IMAGE_MEDIA_TYPES,
  PDF_MEDIA_TYPE,
  "text/*",
  ...Object.keys(TEXT_EXTENSIONS).map((ext) => `.${ext}`),
].join(",");

export const fileExtension = (fileName: string): string => {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return "";
  return fileName.slice(dot + 1).toLowerCase();
};

/** True when the extension is on the text allowlist. Own-property check —
 * a file named `x.constructor` must not match via the prototype chain. */
export const isTextExtension = (ext: string): boolean => Object.hasOwn(TEXT_EXTENSIONS, ext);

/** Markdown language hint for a text attachment; "" when we have none. */
export const textLanguage = (fileName: string): string => {
  const ext = fileExtension(fileName);
  return isTextExtension(ext) ? TEXT_EXTENSIONS[ext]! : "";
};

export const attachmentKind = (mediaType: string): AttachmentKind =>
  mediaType.startsWith("image/") ? "image" : mediaType === PDF_MEDIA_TYPE ? "pdf" : "text";

export const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
