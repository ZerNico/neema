/**
 * Builds a document through the Word adapter with every kind of content it
 * writes, has Microsoft Word (macOS) open it, update its table of contents,
 * report what it sees and save its own copy, then reads that copy back:
 *
 *   node scripts/word-check.ts
 *
 * Run it after bumping @office-kit/docx or changing what the adapter writes.
 * Word must have no documents open; it is quit afterwards if this started it.
 * Word is sandboxed, so files go through its own container folder.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  createWordFile,
  editWordFile,
  inspectWordFile,
} from "../src/modules/word/server/adapter.ts";

/** A small striped PNG, so the picture is visibly real. */
function png(width: number, height: number) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const body = new Uint8Array(4 + data.length);
    body.set(new TextEncoder().encode(type));
    body.set(data, 4);
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(body, 4);
    view.setUint32(8 + data.length, crc(body));
    return out;
  };
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      raw.set(x % 20 < 10 ? [40, 90, 200] : [240, 180, 40], y * (1 + width * 3) + 1 + x * 3);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const first = editWordFile(createWordFile(), [
  { kind: "removeBlocks", blocks: [0] },
  {
    kind: "insertParagraphs",
    at: "end",
    paragraphs: [
      { text: "Quarterly report", style: "title" },
      { text: "Introduction", style: "heading1" },
      { text: "Read **the numbers** at [example.com](https://example.com)." },
      { text: "Scope", style: "heading2" },
      { text: "North", list: "bullet" },
      { text: "South", list: "bullet" },
      { text: "Results", style: "heading1" },
    ],
  },
  {
    kind: "insertTable",
    at: "end",
    rows: [
      ["Region", "Revenue"],
      ["North", "120"],
    ],
  },
  {
    kind: "insertImage",
    at: "end",
    imageRef: png(200, 80),
    width: 8,
    altText: "Stripes",
    caption: "Figure 1: stripes",
  },
]);
// Block numbers mean the revision being edited, so what refers to new blocks comes next.
const built = editWordFile(first.bytes, [
  { kind: "addFootnote", block: 2, text: "Figures are unaudited." },
  { kind: "insertTableOfContents", after: 0, levels: 2 },
  { kind: "setHeader", text: "Confidential" },
  { kind: "setHeader", text: "Draft", mode: "append" },
  { kind: "setFooter", text: "Quarterly report" },
  {
    kind: "setPageNumbers",
    text: "Page {page} of {pages}",
    align: "right",
    size: 9,
    color: "#808080",
    skipFirstPage: true,
  },
  { kind: "setStyle", style: "heading1", font: "Georgia", size: 18, color: "#1F3864" },
  { kind: "setStyle", style: "normal", spaceAfter: 6, lineSpacing: 1.15 },
  { kind: "setPageLayout", size: "A4", margins: "moderate", firstPageDifferent: true },
  { kind: "setTitle", title: "Quarterly report" },
]);

const run = (command: string, args: string[], timeout = 30_000) =>
  execFileSync(command, args, { timeout }).toString().trim();
const wordPid = () => {
  try {
    return run("pgrep", ["-x", "Microsoft Word"]);
  } catch {
    return "";
  }
};
const wasRunning = wordPid() !== "";
if (wasRunning) {
  const open = Number(
    run("osascript", ["-e", 'tell application "Microsoft Word" to count documents']),
  );
  if (open > 0) throw new Error("Close your Word documents first.");
}

const container = join(homedir(), "Library/Containers/com.microsoft.Word/Data/chat-check");
const source = join(container, "word-check.docx");
const saved = join(container, "word-check-saved.docx");
const lines: string[] = [];
try {
  mkdirSync(container, { recursive: true });
  writeFileSync(source, built.bytes);
  // Alerts off and a time limit: a file Word judges damaged fails here with a
  // message instead of leaving Word waiting on a dialog.
  const result = run(
    "osascript",
    [
      "-e",
      `with timeout of 120 seconds
tell application "Microsoft Word"
  set display alerts to alerts none
  try
    open (POSIX file "${source}")
    set checked to active document
    set outcome to "opened"
    set outcome to outcome & linefeed & "tables of contents: " & (count of tables of contents of checked)
    update (table of contents 1 of checked)
    set outcome to outcome & linefeed & "contents: " & (content of text object of table of contents 1 of checked)
    set outcome to outcome & linefeed & "header: " & (content of text object of (get header section 1 of checked index header footer primary))
    set outcome to outcome & linefeed & "footer: " & (content of text object of (get footer section 1 of checked index header footer primary))
    set outcome to outcome & linefeed & "pictures: " & (count of inline shapes of checked)
    set outcome to outcome & linefeed & "footnotes: " & (count of footnotes of checked)
    set outcome to outcome & linefeed & "links: " & (count of hyperlinks of checked)
    set outcome to outcome & linefeed & "tables: " & (count of tables of checked)
    save as checked file name (POSIX file "${saved}" as text) file format format document
    close checked saving no
  on error errText
    set outcome to "refused: " & errText
  end try
  return outcome
end tell
end timeout`,
    ],
    150_000,
  );
  lines.push(...result.split(/\r|\n/));
  if (!result.startsWith("opened")) throw new Error(`Word would not open the document: ${result}`);
  // What Word saved, read back by the app.
  const inspected = inspectWordFile(new Uint8Array(readFileSync(saved)));
  lines.push(
    `read back: ${inspected.blocks.length} blocks, outline ${JSON.stringify(inspected.outline.map((item) => item.text))}, ` +
      `headers ${JSON.stringify(inspected.headers)}, footers ${JSON.stringify(inspected.footers)}, ` +
      `pictures ${inspected.images}, footnotes ${inspected.footnotes}, ` +
      `contents ${inspected.blocks.some((item) => item.type === "tableOfContents")}`,
  );
} finally {
  if (!wasRunning && wordPid())
    try {
      run("osascript", ["-e", 'tell application "Microsoft Word" to quit saving no']);
    } catch {
      // Reported by the caller's own check of the process list.
    }
  rmSync(container, { recursive: true, force: true });
}
console.log(lines.join("\n"));
