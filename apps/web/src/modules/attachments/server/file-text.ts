import { Effect } from "effect";
import { crc32 } from "node:zlib";
import { fileExtension, formatFileSize } from "../constants.ts";
import { decodeXmlText } from "../xml-text.ts";
import { readZip } from "../zip.ts";
import { buildTextFence } from "./validation.ts";

/** Bounds on what a small archive may expand into while it is read. */
const EXPANDED_BYTES = 40 * 1024 * 1024;
const EXPANSION_RATIO = 100;
/** The same order of size as a PDF's extracted text. */
export const FILE_TEXT_CHARS = 120_000;

/**
 * How a file the model cannot read is named to it: enough to say what it is,
 * and the id a tool that takes files accepts.
 */
export const describeFile = (file: { id?: string; fileName: string; size: number }) =>
  `Attached file: ${file.fileName} (${formatFileSize(file.size)}${file.id ? `, id ${file.id}` : ""}). Its contents are not readable here; a tool that takes files can use it. If none can, say so rather than guessing at what it contains.`;

/**
 * The entries of a ZIP that `wanted` selects, or null when the archive is not
 * one this reader accepts. Output and expansion ratio are bounded, so a small
 * hostile file cannot inflate into memory.
 */
function readEntries(bytes: Uint8Array, wanted: (name: string) => boolean) {
  try {
    const entries = readZip(bytes, {
      limits: {
        archiveBytes: Number.MAX_SAFE_INTEGER,
        entries: 10_000,
        entryBytes: EXPANDED_BYTES,
        expandedBytes: EXPANDED_BYTES,
        expansionRatio: EXPANSION_RATIO,
      },
      fail: (message) => {
        throw new Error(message);
      },
      wanted,
      crc32,
    });
    // No wanted entry at all means this is not the package its name claims.
    return entries.size === 0 ? null : entries;
  } catch {
    return null;
  }
}

const utf8 = (bytes: Uint8Array | undefined) => (bytes ? new TextDecoder().decode(bytes) : "");
/** The text runs of one XML element kind, paragraph by paragraph. */
const paragraphs = (xml: string, paragraph: string, run: string) =>
  xml
    .split(`</${paragraph}>`)
    .map((part) =>
      [...part.matchAll(new RegExp(`<${run}(?:\\s[^>]*)?>([^<]*)</${run}>`, "g"))]
        .map((match) => decodeXmlText(match[1]!))
        .join(""),
    )
    .filter((line) => line.trim() !== "");
const numbered = (name: string, pattern: RegExp) => Number(pattern.exec(name)?.[1] ?? 0);

function presentationText(bytes: Uint8Array) {
  const slide = /^ppt\/slides\/slide(\d+)\.xml$/;
  const entries = readEntries(bytes, (name) => slide.test(name));
  if (!entries) return null;
  return [...entries.keys()]
    .toSorted((a, b) => numbered(a, slide) - numbered(b, slide))
    .map((name) => {
      const lines = paragraphs(utf8(entries.get(name)), "a:p", "a:t");
      return `## Slide ${numbered(name, slide)}\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

function documentText(bytes: Uint8Array) {
  const entries = readEntries(bytes, (name) => name === "word/document.xml");
  if (!entries) return null;
  return paragraphs(utf8(entries.get("word/document.xml")), "w:p", "w:t").join("\n");
}

function workbookText(bytes: Uint8Array) {
  const sheet = /^xl\/worksheets\/sheet(\d+)\.xml$/;
  const entries = readEntries(
    bytes,
    (name) => sheet.test(name) || name === "xl/sharedStrings.xml" || name === "xl/workbook.xml",
  );
  if (!entries) return null;
  const shared = utf8(entries.get("xl/sharedStrings.xml"))
    .split("</si>")
    .slice(0, -1)
    .map((item) =>
      [...item.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => decodeXmlText(m[1]!)).join(""),
    );
  const names = [
    ...utf8(entries.get("xl/workbook.xml")).matchAll(/<sheet\s[^>]*name="([^"]*)"/g),
  ].map((match) => decodeXmlText(match[1]!));
  return [...entries.keys()]
    .filter((name) => sheet.test(name))
    .toSorted((a, b) => numbered(a, sheet) - numbered(b, sheet))
    .map((name) => {
      const index = numbered(name, sheet);
      const rows = [...utf8(entries.get(name)).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(
        (row) =>
          [...row[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
            .map((cell) => {
              const value = /<v>([^<]*)<\/v>/.exec(cell[2] ?? "")?.[1];
              const inline = /<t(?:\s[^>]*)?>([^<]*)<\/t>/.exec(cell[2] ?? "")?.[1];
              if (/\bt="s"/.test(cell[1]!) && value !== undefined)
                return shared[Number(value)] ?? "";
              return decodeXmlText(value ?? inline ?? "");
            })
            .join("\t"),
      );
      return `## ${names[index - 1] ?? `Sheet ${index}`}\n${rows.join("\n")}`;
    })
    .join("\n\n");
}

/**
 * An SVG is XML a model reads well: its source, as long as it is valid UTF-8.
 * It stays a download, since served inline it is active content on our origin.
 */
function svgText(bytes: Uint8Array) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return /<svg[\s>]/i.test(text) ? text : null;
  } catch {
    return null;
  }
}

const OFFICE_READERS: Record<string, (bytes: Uint8Array) => string | null> = {
  pptx: presentationText,
  docx: documentText,
  xlsx: workbookText,
  svg: svgText,
};

/**
 * The readable text of a file that is not plain text, image or PDF, or null
 * when there is no reader for it or it could not be read. Office documents
 * give their text without formatting, images or notes. New formats belong here.
 */
/** Whether `fileText` could say anything, so bytes are loaded only when useful. */
export const hasFileText = (fileName: string) =>
  Object.hasOwn(OFFICE_READERS, fileExtension(fileName));

export function fileText(fileName: string, bytes: Uint8Array, maxChars = FILE_TEXT_CHARS) {
  const extension = fileExtension(fileName);
  const reader = Object.hasOwn(OFFICE_READERS, extension) ? OFFICE_READERS[extension]! : null;
  const text = reader?.(bytes) ?? null;
  return text === null ? null : text.slice(0, maxChars);
}

/** Bump when a reader changes what it returns, so cached text is read again. */
const FILE_TEXT_REVISION = "file-text-1";
/**
 * Names the reader a blob's cached text came from. The reader follows the
 * file's extension and one blob can be attached under several names, so the
 * extension is part of it.
 */
const fileTextFingerprint = (fileName: string, readable: boolean) =>
  `${FILE_TEXT_REVISION}:${fileExtension(fileName)}${readable ? "" : ":unreadable"}`;

/** A blob's stored text, and how to store it once read. */
export interface FileTextCache<R> {
  readonly parsedText: string | null;
  readonly parsedWith: string | null;
  readonly save: (text: string, parsedWith: string) => Effect.Effect<void, never, R>;
}

/**
 * An opaque file in a prompt: its text when there is a reader for it, and
 * otherwise a line naming it, so the model knows it is there and says what it
 * cannot do instead of guessing. Bytes are only loaded when they can be read,
 * and with a cache only the first time: unzipping on every turn stalls the server.
 */
export const opaqueFileText = <E, R, C = never>(
  file: { id?: string; fileName: string; size: number },
  bytes: () => Effect.Effect<Uint8Array, E, R>,
  /** Shortens long text for the prompt; the whole file stays readable by tool. */
  fit: (text: string) => string = (text) => text,
  cache?: FileTextCache<C>,
) =>
  Effect.gen(function* () {
    if (!hasFileText(file.fileName)) return describeFile(file);
    let text: string | null;
    if (cache?.parsedWith === fileTextFingerprint(file.fileName, true))
      text = cache.parsedText ?? "";
    else if (cache?.parsedWith === fileTextFingerprint(file.fileName, false)) text = null;
    else {
      text = fileText(file.fileName, yield* bytes());
      if (cache) yield* cache.save(text ?? "", fileTextFingerprint(file.fileName, text !== null));
    }
    return text === null
      ? describeFile(file)
      : buildTextFence({
          fileName: file.fileName,
          text: fit(text),
          label: `Attached file${file.id ? ` (id ${file.id})` : ""}, text only`,
        });
  });
