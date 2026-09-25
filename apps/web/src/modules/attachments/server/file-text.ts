import { Effect } from "effect";
import { Unzip, UnzipInflate } from "fflate";
import { fileExtension, formatFileSize } from "../constants.ts";
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
 * The entries of a ZIP that `wanted` selects, expanded with the same guards
 * the skill importer uses: total output and expansion ratio are bounded, so a
 * small hostile file cannot inflate into memory.
 */
function readEntries(bytes: Uint8Array, wanted: (name: string) => boolean) {
  const entries = new Map<string, Uint8Array>();
  let total = 0;
  let failed = false;
  const unzip = new Unzip((file) => {
    if (!wanted(file.name)) return;
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (error, chunk, final) => {
      if (error || failed) return;
      size += chunk.length;
      total += chunk.length;
      if (total > EXPANDED_BYTES || total > bytes.length * EXPANSION_RATIO) {
        failed = true;
        file.terminate();
        return;
      }
      chunks.push(chunk);
      if (final) {
        const output = new Uint8Array(size);
        let offset = 0;
        for (const part of chunks) {
          output.set(part, offset);
          offset += part.length;
        }
        entries.set(file.name, output);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    for (let offset = 0; offset < bytes.length && !failed; offset += 4096)
      unzip.push(bytes.subarray(offset, offset + 4096), offset + 4096 >= bytes.length);
  } catch {
    return null;
  }
  // No wanted entry at all means this is not the package its name claims.
  return failed || entries.size === 0 ? null : entries;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
const decodeXml = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X"))
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return ENTITIES[entity] ?? match;
  });
const utf8 = (bytes: Uint8Array | undefined) => (bytes ? new TextDecoder().decode(bytes) : "");
/** The text runs of one XML element kind, paragraph by paragraph. */
const paragraphs = (xml: string, paragraph: string, run: string) =>
  xml
    .split(`</${paragraph}>`)
    .map((part) =>
      [...part.matchAll(new RegExp(`<${run}(?:\\s[^>]*)?>([^<]*)</${run}>`, "g"))]
        .map((match) => decodeXml(match[1]!))
        .join(""),
    )
    .filter((line) => line.trim() !== "");
const numbered = (name: string, pattern: RegExp) => Number(pattern.exec(name)?.[1] ?? 0);

function presentationText(bytes: Uint8Array) {
  const slide = /^ppt\/slides\/slide(\d+)\.xml$/;
  const entries = readEntries(bytes, (name) => slide.test(name));
  if (!entries) return null;
  return [...entries.keys()]
    .sort((a, b) => numbered(a, slide) - numbered(b, slide))
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
      [...item.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => decodeXml(m[1]!)).join(""),
    );
  const names = [
    ...utf8(entries.get("xl/workbook.xml")).matchAll(/<sheet\s[^>]*name="([^"]*)"/g),
  ].map((match) => decodeXml(match[1]!));
  return [...entries.keys()]
    .filter((name) => sheet.test(name))
    .sort((a, b) => numbered(a, sheet) - numbered(b, sheet))
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
              return decodeXml(value ?? inline ?? "");
            })
            .join("\t"),
      );
      return `## ${names[index - 1] ?? `Sheet ${index}`}\n${rows.join("\n")}`;
    })
    .join("\n\n");
}

const OFFICE_READERS: Record<string, (bytes: Uint8Array) => string | null> = {
  pptx: presentationText,
  docx: documentText,
  xlsx: workbookText,
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

/**
 * An opaque file in a prompt: its text when there is a reader for it, and
 * otherwise a line naming it, so the model knows it is there and says what it
 * cannot do instead of guessing. Bytes are only loaded when they can be read.
 */
export const opaqueFileText = <E, R>(
  file: { id?: string; fileName: string; size: number },
  bytes: () => Effect.Effect<Uint8Array, E, R>,
) =>
  Effect.gen(function* () {
    if (!hasFileText(file.fileName)) return describeFile(file);
    const text = fileText(file.fileName, yield* bytes());
    return text === null
      ? describeFile(file)
      : buildTextFence({
          fileName: file.fileName,
          text,
          label: `Attached file${file.id ? ` (id ${file.id})` : ""}, text only`,
        });
  });
