// Loaded by the Word worker under plain Node in development: relative imports only.
import {
  acceptAllRevisions,
  commentsPart,
  endnotesPart,
  footers,
  footnotesPart,
  getParagraphAlignment,
  getParagraphStyle,
  headers,
  numberingPart,
  stylesPart,
  title,
  type Docx,
  type WmlBlock,
  type WmlInline,
  type WmlParagraph,
  type WmlRunPiece,
  type WmlTable,
} from "@office-kit/docx";
import { strFromU8 } from "fflate";
import { WordError } from "../errors.ts";
import {
  attributeOf,
  childNamed,
  elementsNamed,
  openWordFile,
  xmlText,
  type XmlElement,
} from "./adapter.ts";
import { CALLOUT_LABELS, LEVEL_TWIPS, MATH_FONT, TASK_BOXES } from "./document-export.ts";
import {
  IMAGE_REF,
  type DocumentBounds,
  type ImportedThread,
  type TreeMark,
  type TreeNode,
  type WordAsDocument,
} from "./document-tree.ts";

/** The blocks a document counts toward its cap, as `documents/editor/block-ids.ts` lists them. */
const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "codeBlock",
  "bulletList",
  "orderedList",
  "taskList",
  "listItem",
  "taskItem",
  "table",
  "horizontalRule",
  "blockMath",
  "callout",
  "details",
]);

const MONOSPACE =
  /^(?:consolas|courier(?: new)?|menlo|monaco|lucida console|lucida sans typewriter|source code pro|cascadia (?:code|mono)|sf mono|fira (?:code|mono)|jetbrains mono|roboto mono|ubuntu mono|dejavu sans mono|liberation mono|andale mono|inconsolata|ibm plex mono|noto sans mono|monospace)$/i;
const CODE_STYLES = /^(?:html preformatted|source code|code|plain text|macro text)$/i;
const QUOTE_STYLES = /^(?:quote|intense quote|block text)$/i;
const CALLOUTS = new Map(
  Object.entries(CALLOUT_LABELS).map(([kind, look]) => [look.label.toLowerCase(), kind]),
);
const TASK_START = new RegExp(`^[${TASK_BOXES.open}${TASK_BOXES.done}☒]\\s?`);

/** What a run's properties switch on or off; absent keys inherit. */
interface Flags {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  underline?: boolean;
  highlight?: boolean;
  code?: boolean;
  math?: boolean;
}
/** A run's content as one shape, whether the library typed the run or kept it as markup. */
type Piece =
  | { kind: "text"; value: string }
  | { kind: "break" }
  | { kind: "drawing"; node: XmlElement }
  | { kind: "legacy" }
  | { kind: "note"; notes: "footnote" | "endnote"; id: string }
  | { kind: "begin" }
  | { kind: "instruction"; value: string }
  | { kind: "separate" }
  | { kind: "end" };

const isOn = (node: XmlElement) => {
  const value = attributeOf(node, "val");
  return value === undefined || !["0", "false", "off", "none"].includes(value.toLowerCase());
};
const plural = (count: number, one: string, many: string) =>
  count === 1 ? `${/^[aeiou]/i.test(one) ? "an" : "a"} ${one}` : `${count} ${many}`;

/** Which kind of picture a document can show, from its bytes. */
const pictureType = (bytes: Uint8Array) => {
  const head = (length: number, at = 0) =>
    String.fromCharCode(...bytes.subarray(at, Math.min(bytes.length, at + length)));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (head(8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (head(4) === "GIF8") return "image/gif";
  if (head(4) === "RIFF" && head(4, 8) === "WEBP") return "image/webp";
  return null;
};

/**
 * A Word file as a live document's tree: headings by outline level and the
 * built-in heading styles, lists by their numbering, tables with merged
 * cells, footnotes, links, pictures and comments. What a document cannot
 * hold is named in `dropped`, never left out silently.
 */
export function wordToDocument(bytes: Uint8Array, bounds: DocumentBounds): WordAsDocument {
  const doc = openWordFile(bytes);
  // Tracked changes read as accepted, which is what Word shows with markup off.
  acceptAllRevisions(doc);
  return new WordReader(doc, bounds).read();
}

/** What one paragraph is on its own, before neighbours group. */
type Classified =
  | { kind: "heading"; level: number }
  | { kind: "bullet" | "ordered"; level: number; number: number }
  | { kind: "task"; level: number; checked: boolean }
  | { kind: "code" | "quote" | "rule" | "math" }
  | { kind: "calloutPart"; label: string | null }
  | { kind: "paragraph"; level: number | null };
type ParagraphEntry = {
  kind: "paragraph";
  paragraph: WmlParagraph;
  inline: TreeNode[];
  is: Classified;
};
type Entry = ParagraphEntry | { kind: "block"; nodes: TreeNode[] };

const withoutBold = (node: TreeNode): TreeNode => {
  const marks = node.marks?.filter((mark) => mark.type !== "bold");
  return {
    ...node,
    ...(node.marks ? { marks: marks! } : {}),
    ...(node.content ? { content: node.content.map(withoutBold) } : {}),
  };
};

const paragraphContent = (inline: readonly TreeNode[]) =>
  inline.length ? { content: [...inline] } : {};
/** A paragraph of inline nodes; an empty one has no content. */
const paragraphNode = (inline: readonly TreeNode[]): TreeNode => ({
  type: "paragraph",
  ...paragraphContent(inline),
});
/** The list level an indent in twips stands for, as the export indents task items. */
const levelOf = (twips: number) => Math.max(0, Math.round(twips / LEVEL_TWIPS) - 1);

/** A list level's format and start, by list and level, from the numbering part. */
function numberingOf(doc: Docx) {
  const part = numberingPart(doc);
  const abstracts = new Map<string, XmlElement>();
  for (const each of part?.abstractNums ?? []) {
    const id = attributeOf(each, "abstractNumId");
    if (id) abstracts.set(id, each);
  }
  const nums = new Map<string, XmlElement>();
  for (const each of part?.nums ?? []) {
    const id = attributeOf(each, "numId");
    if (id) nums.set(id, each);
  }
  /** A list level's format and where it starts counting. */
  return (numId: string, level: number) => {
    const num = nums.get(numId);
    if (!num) return null;
    const abstractId = attributeOf(childNamed(num, "abstractNumId") ?? num, "val");
    const override = num.children.find(
      (child): child is XmlElement =>
        child.kind === "element" &&
        child.name.local === "lvlOverride" &&
        attributeOf(child, "ilvl") === String(level),
    );
    const levels = (holder: XmlElement | undefined) =>
      holder?.children.find(
        (child): child is XmlElement =>
          child.kind === "element" &&
          child.name.local === "lvl" &&
          attributeOf(child, "ilvl") === String(level),
      );
    const definition = levels(override) ?? levels(abstracts.get(abstractId ?? ""));
    const format = attributeOf(childNamed(definition, "numFmt") ?? definition ?? num, "val");
    const startOverride = childNamed(override, "startOverride");
    const start = Number(
      (startOverride && attributeOf(startOverride, "val")) ??
        attributeOf(childNamed(definition, "start") ?? num, "val") ??
        1,
    );
    return {
      bullet: !format || format === "bullet" || format === "none",
      start: Number.isFinite(start) ? start : 1,
    };
  };
}

class WordReader {
  readonly #styles = new Map<string, XmlElement>();
  readonly #notes = { footnote: new Map<string, string>(), endnote: new Map<string, string>() };
  readonly #images = new Map<string, number>();
  readonly #imageList: WordAsDocument["images"] = [];
  readonly #lost = new Map<string, number>();
  /** Open complex fields, outermost first: their instruction, and whether their result has begun. */
  readonly #fields: Array<{ instruction: string; result: boolean }> = [];
  /** Comment ranges open where the reader is, by Word comment id. */
  readonly #active = new Set<string>();
  /** Each Word comment's thread, by its id. */
  readonly #threadOf = new Map<string, ImportedThread>();
  readonly #threads: ImportedThread[] = [];
  #toc = false;
  /** Where inline content goes while one paragraph is read. */
  #out: TreeNode[] = [];
  readonly #numbering: ReturnType<typeof numberingOf>;
  /** Each numbered paragraph's number, counted once however often it is classified. */
  readonly #numbers = new Map<WmlParagraph, number>();
  readonly #counters = new Map<string, number[]>();

  /** Plain fields: the worker runs under Node's type stripping, which has no parameter properties. */
  readonly doc: Docx;
  /** The document's limits, which the file must fit whole. */
  readonly bounds: DocumentBounds;

  constructor(doc: Docx, bounds: DocumentBounds) {
    this.doc = doc;
    this.bounds = bounds;
    for (const style of stylesPart(doc)?.styles ?? []) {
      const id = attributeOf(style, "styleId");
      if (id) this.#styles.set(id, style);
    }
    for (const [kind, part] of [
      ["footnote", footnotesPart(doc)],
      ["endnote", endnotesPart(doc)],
    ] as const)
      for (const note of part?.footnotes ?? []) {
        const id = attributeOf(note, "id");
        // Separators are Word's own lines between text and notes.
        if (id && !attributeOf(note, "type"))
          this.#notes[kind].set(
            id,
            elementsNamed(note, "p")
              .map((paragraph) => xmlText(paragraph).trim())
              .filter(Boolean)
              .join(" "),
          );
      }
    this.#numbering = numberingOf(doc);
    this.readComments();
  }

  read(): WordAsDocument {
    const content = this.blocks(this.doc.document.body.blocks, true);
    const tree: TreeNode = {
      type: "doc",
      content: content.length ? content : [{ type: "paragraph" }],
    };
    this.measure(tree);
    if (
      headers(this.doc).some((part) => part.text.trim()) ||
      footers(this.doc).some((part) => part.text.trim())
    )
      this.lose("headers and footers");
    const lost = [...this.#lost].map(([what, count]) =>
      what.includes("|") ? plural(count, ...(what.split("|") as [string, string])) : what,
    );
    const name = title(this.doc)?.trim();
    return {
      title: name ? name.slice(0, 200) : null,
      tree,
      images: this.#imageList,
      threads: this.#threads,
      dropped: lost,
    };
  }

  /** `what` is a phrase, or `one|many` to count. */
  private lose(what: string, count = 1) {
    this.#lost.set(what, (this.#lost.get(what) ?? 0) + count);
  }

  /** Refuses a file past the document's limits rather than storing part of it. */
  private measure(tree: TreeNode) {
    let blocks = 0;
    let chars = 0;
    const walk = (node: TreeNode) => {
      if (BLOCK_TYPES.has(node.type)) blocks += 1;
      chars += node.text?.length ?? 0;
      node.content?.forEach(walk);
    };
    walk(tree);
    if (blocks > this.bounds.blocks)
      throw new WordError(
        "limit",
        `This Word file is too long for a document: it has ${blocks.toLocaleString("en-US")} paragraphs, list items and tables, and a document holds ${this.bounds.blocks.toLocaleString("en-US")}.`,
      );
    if (chars > this.bounds.chars)
      throw new WordError(
        "limit",
        `This Word file is too long for a document: it has ${chars.toLocaleString("en-US")} characters, and a document holds ${this.bounds.chars.toLocaleString("en-US")}.`,
      );
  }

  // -------------------------------------------------------------------------
  // Styles and numbering

  /** A style and those it is based on, nearest first. */
  private chain(id: string | undefined) {
    const found: XmlElement[] = [];
    for (let next = id; next && found.length < 10;) {
      const style = this.#styles.get(next);
      if (!style || found.includes(style)) break;
      found.push(style);
      const based = childNamed(style, "basedOn");
      next = based && attributeOf(based, "val");
    }
    return found;
  }
  private styleName(id: string | undefined) {
    const style = id ? this.#styles.get(id) : undefined;
    const name = childNamed(style, "name");
    return ((name && attributeOf(name, "val")) ?? id ?? "").toLowerCase();
  }
  /** The first `local` element in the paragraph properties of a style or those it is based on. */
  private styleProperty(id: string | undefined, local: string) {
    for (const style of this.chain(id)) {
      const found = childNamed(childNamed(style, "pPr"), local);
      if (found) return found;
    }
    return undefined;
  }

  /** The number Word gives this item: counted per list and level, deeper levels restarting. */
  private count(numId: string, level: number, start: number) {
    const counts = this.#counters.get(numId) ?? [];
    counts[level] = (counts[level] ?? start - 1) + 1;
    counts.length = level + 1;
    this.#counters.set(numId, counts);
    return counts[level]!;
  }

  // -------------------------------------------------------------------------
  // Comments

  /** Word's comments as threads: a reply joins its parent's thread, by commentsExtended. */
  private readComments() {
    const comments = commentsPart(this.doc)?.comments ?? [];
    if (!comments.length) return;
    // Replies and resolved threads are recorded beside the comments, by each comment's last paragraph.
    const extended = [...this.doc.opc.parts.values()].find((part) =>
      part.contentType.includes("commentsExtended"),
    );
    const parentOf = new Map<string, string>();
    const done = new Set<string>();
    if (extended)
      for (const [entry] of strFromU8(extended.data).matchAll(/<\w+:commentEx\b[^>]*>/g)) {
        const paraId = /:paraId="([^"]+)"/.exec(entry)?.[1];
        const parent = /:paraIdParent="([^"]+)"/.exec(entry)?.[1];
        if (paraId && parent) parentOf.set(paraId, parent);
        if (paraId && /:done="1"/.test(entry)) done.add(paraId);
      }
    const byParagraph = new Map<string, string>();
    const paragraphOf = new Map<string, string>();
    for (const comment of comments) {
      const id = attributeOf(comment, "id");
      const last = elementsNamed(comment, "p").at(-1);
      const paraId = last && attributeOf(last, "paraId");
      if (id && paraId) {
        byParagraph.set(paraId, id);
        paragraphOf.set(id, paraId);
      }
    }
    let total = 0;
    let clipped = 0;
    let over = 0;
    for (const comment of comments) {
      const id = attributeOf(comment, "id");
      if (!id) continue;
      let root = id;
      for (let hops = 0; hops < 50; hops++) {
        const parent = parentOf.get(paragraphOf.get(root) ?? "");
        const parentId = parent && byParagraph.get(parent);
        if (!parentId || parentId === root) break;
        root = parentId;
      }
      if (total >= this.bounds.comments) {
        over += 1;
        continue;
      }
      let text = elementsNamed(comment, "p")
        .map((paragraph) => xmlText(paragraph).trim())
        .join("\n")
        .trim();
      if (text.length > this.bounds.comment) {
        text = `${text.slice(0, this.bounds.comment - 1)}…`;
        clipped += 1;
      }
      const entry = {
        author: (attributeOf(comment, "author") ?? "").slice(0, 200),
        text: text || "…",
      };
      const thread = this.#threadOf.get(root);
      if (thread) {
        thread.comments.push(entry);
        this.#threadOf.set(id, thread);
      } else {
        const made: ImportedThread = {
          ref: `comment:${root}`,
          comments: [entry],
          quote: "",
          resolved: done.has(paragraphOf.get(root) ?? ""),
        };
        this.#threads.push(made);
        this.#threadOf.set(id, made);
      }
      total += 1;
    }
    if (over)
      this.lose("comment past the document’s limit|comments past the document’s limit", over);
    if (clipped) this.lose("comment shortened|comments shortened", clipped);
  }

  // -------------------------------------------------------------------------
  // Inline content

  /** What a run's properties switch on, its character style's first. */
  private flags(rPr: XmlElement | undefined, depth = 0): Flags {
    if (!rPr) return {};
    const flags: Flags = {};
    // A character style first, so the run's own settings win.
    const style = childNamed(rPr, "rStyle");
    if (style && depth < 10)
      for (const each of this.chain(attributeOf(style, "val")).toReversed())
        Object.assign(flags, this.flags(childNamed(each, "rPr"), depth + 1));
    for (const child of rPr.children) {
      if (child.kind !== "element") continue;
      switch (child.name.local) {
        case "b":
          flags.bold = isOn(child);
          break;
        case "i":
          flags.italic = isOn(child);
          break;
        case "strike":
        case "dstrike":
          flags.strike = isOn(child);
          break;
        case "u":
          flags.underline = isOn(child);
          break;
        case "highlight":
          flags.highlight = isOn(child);
          break;
        case "rFonts": {
          const font = attributeOf(child, "ascii") ?? attributeOf(child, "hAnsi") ?? "";
          flags.code = MONOSPACE.test(font);
          flags.math = font === MATH_FONT;
          break;
        }
      }
    }
    return flags;
  }

  private piecesOfRun(pieces: readonly WmlRunPiece[]): Piece[] {
    return pieces.flatMap((piece): Piece[] => {
      switch (piece.kind) {
        case "text":
          return [{ kind: "text", value: piece.value }];
        case "tab":
          return [{ kind: "text", value: "\t" }];
        case "break":
          return piece.breakType === "page" || piece.breakType === "column"
            ? []
            : [{ kind: "break" }];
        case "noBreakHyphen":
          return [{ kind: "text", value: "-" }];
        case "drawing":
          return [{ kind: "drawing", node: piece.node }];
        case "pict":
          return [{ kind: "legacy" }];
        case "instrText":
          return [{ kind: "instruction", value: piece.value }];
        case "fieldChar":
          return [{ kind: piece.charType === "begin" ? "begin" : piece.charType }];
        case "raw":
          return this.piecesOfElement(piece.node);
        default:
          return [];
      }
    });
  }
  /** One child of a run kept as markup. */
  private piecesOfElement(node: XmlElement): Piece[] {
    switch (node.name.local) {
      case "t":
        return [{ kind: "text", value: xmlText(node) }];
      case "tab":
        return [{ kind: "text", value: "\t" }];
      case "br":
      case "cr": {
        const type = attributeOf(node, "type");
        return type === "page" || type === "column" ? [] : [{ kind: "break" }];
      }
      case "noBreakHyphen":
        return [{ kind: "text", value: "-" }];
      case "drawing":
        return [{ kind: "drawing", node }];
      case "pict":
      case "object":
        return [{ kind: "legacy" }];
      case "footnoteReference":
      case "endnoteReference":
        return [
          {
            kind: "note",
            notes: node.name.local === "footnoteReference" ? "footnote" : "endnote",
            id: attributeOf(node, "id") ?? "",
          },
        ];
      case "instrText":
        return [
          { kind: "instruction", value: xmlText({ ...node, name: { ...node.name, local: "t" } }) },
        ];
      case "fldChar": {
        const type = attributeOf(node, "fldCharType");
        return type === "begin" || type === "separate" || type === "end" ? [{ kind: type }] : [];
      }
      default:
        return [];
    }
  }

  /** The address a field's result links to, when it is a HYPERLINK field. */
  private fieldLink() {
    for (const field of this.#fields.toReversed()) {
      const match = /^\s*HYPERLINK\s+"([^"]+)"/i.exec(field.instruction);
      if (match) return match[1]!;
    }
    return null;
  }

  private run(rPr: XmlElement | undefined, pieces: readonly Piece[], link: string | null) {
    const flags = this.flags(rPr);
    for (const piece of pieces) {
      const field = this.#fields.at(-1);
      switch (piece.kind) {
        case "begin":
          this.#fields.push({ instruction: "", result: false });
          continue;
        case "instruction":
          if (field && !field.result) field.instruction += piece.value;
          continue;
        case "separate":
          if (field) {
            field.result = true;
            if (/^\s*TOC\b/.test(field.instruction)) {
              this.#toc = true;
              this.lose("a table of contents, which Word rebuilds from the headings");
            }
          }
          continue;
        case "end":
          if (field && /^\s*TOC\b/.test(field.instruction)) this.#toc = false;
          this.#fields.pop();
          continue;
      }
      // A field's instruction is code, not text.
      if (field && !field.result) continue;
      switch (piece.kind) {
        case "text":
          this.text(piece.value, flags, link ?? this.fieldLink());
          break;
        case "break":
          this.#out.push({ type: "hardBreak" });
          break;
        case "drawing":
          this.drawing(piece.node);
          break;
        case "legacy":
          this.lose("picture or object in an older format|pictures or objects in an older format");
          break;
        case "note": {
          const note = this.#notes[piece.notes].get(piece.id);
          if (note) this.#out.push({ type: "footnote", attrs: { note } });
          break;
        }
      }
    }
  }

  private text(value: string, flags: Flags, link: string | null) {
    if (!value) return;
    const marks: TreeMark[] = [];
    if (flags.code) marks.push({ type: "code" });
    else {
      const href = link && /^(?:https?:|mailto:)/i.test(link) ? link : null;
      if (href) marks.push({ type: "link", attrs: { href } });
      if (flags.bold) marks.push({ type: "bold" });
      if (flags.italic) marks.push({ type: "italic" });
      if (flags.strike) marks.push({ type: "strike" });
      if (flags.underline && !href) marks.push({ type: "underline" });
      if (flags.highlight) marks.push({ type: "highlight" });
    }
    const threads = new Set<ImportedThread>();
    for (const id of this.#active) {
      const thread = this.#threadOf.get(id);
      if (thread) threads.add(thread);
    }
    for (const thread of threads) {
      if (thread.quote.length < this.bounds.quote)
        thread.quote = (thread.quote + value).slice(0, this.bounds.quote);
      // Code takes no other mark, a comment's included.
      if (!flags.code) marks.push({ type: "comment", attrs: { thread: thread.ref } });
    }
    if (flags.math) {
      this.#out.push({ type: "inlineMath", attrs: { latex: value } });
      return;
    }
    this.#out.push({ type: "text", text: value, ...(marks.length ? { marks } : {}) });
  }

  private drawing(node: XmlElement) {
    const blip = elementsNamed(node, "blip")[0];
    if (!blip) {
      if (elementsNamed(node, "txbxContent").length) this.lose("text box|text boxes");
      else this.lose("chart, diagram or shape|charts, diagrams or shapes");
      return;
    }
    const embed = attributeOf(blip, "embed");
    const rel = this.doc.opc.relsBySource
      .get(this.doc.partName)
      ?.relationships.find((each) => each.id === embed);
    const part =
      rel && rel.targetMode !== "External"
        ? new URL(rel.target, `http://part${this.doc.partName}`).pathname
        : null;
    const data = part ? this.doc.opc.parts.get(part)?.data : undefined;
    if (!part || !data) {
      this.lose("linked picture|linked pictures");
      return;
    }
    const mediaType = pictureType(data);
    if (!mediaType) {
      this.lose(
        "picture in a format a document can’t show|pictures in formats a document can’t show",
      );
      return;
    }
    if (data.length > this.bounds.imageBytes) {
      this.lose("picture too large to keep|pictures too large to keep");
      return;
    }
    let index = this.#images.get(part);
    if (index === undefined) {
      index = this.#imageList.length;
      this.#imageList.push({ bytes: data, mediaType });
      this.#images.set(part, index);
    }
    const extent = elementsNamed(node, "extent")[0];
    const width = Math.round(Number(extent ? attributeOf(extent, "cx") : 0) / 9_525);
    const height = Math.round(Number(extent ? attributeOf(extent, "cy") : 0) / 9_525);
    const described = elementsNamed(node, "docPr")[0];
    const alt = ((described && attributeOf(described, "descr")) ?? "").slice(0, 500);
    this.#out.push({
      type: "image",
      attrs: {
        src: `${IMAGE_REF}${index}`,
        alt,
        ...(width > 0 && height > 0 ? { width, height } : {}),
      },
    });
  }

  private inlineElement(node: XmlElement, link: string | null) {
    switch (node.name.local) {
      case "r":
        this.run(
          childNamed(node, "rPr"),
          node.children.flatMap((child) =>
            child.kind === "element" && child.name.local !== "rPr"
              ? this.piecesOfElement(child)
              : [],
          ),
          link,
        );
        return;
      case "hyperlink": {
        const id = attributeOf(node, "id");
        const rel = id
          ? this.doc.opc.relsBySource
              .get(this.doc.partName)
              ?.relationships.find((each) => each.id === id)
          : undefined;
        this.children(node, rel?.targetMode === "External" ? rel.target : link);
        return;
      }
      case "fldSimple": {
        const instruction = attributeOf(node, "instr") ?? "";
        const match = /^\s*HYPERLINK\s+"([^"]+)"/i.exec(instruction);
        this.children(node, match ? match[1]! : link);
        return;
      }
      case "commentRangeStart":
      case "commentRangeEnd": {
        const id = attributeOf(node, "id");
        if (id && node.name.local === "commentRangeStart") this.#active.add(id);
        else if (id) this.#active.delete(id);
        return;
      }
      case "oMath":
      case "oMathPara": {
        const text = elementsNamed(node, "t")
          .map((each) =>
            each.children.map((child) => (child.kind === "text" ? child.value : "")).join(""),
          )
          .join("");
        this.lose("equation, kept as its text|equations, kept as their text");
        this.text(text, {}, link);
        return;
      }
      case "del":
      case "moveFrom":
      case "bookmarkStart":
      case "bookmarkEnd":
      case "proofErr":
      case "permStart":
      case "permEnd":
        return;
      case "sdt":
        this.children(childNamed(node, "sdtContent") ?? node, link);
        return;
      default:
        this.children(node, link);
    }
  }
  private children(node: XmlElement, link: string | null) {
    for (const child of node.children)
      if (child.kind === "element") this.inlineElement(child, link);
  }

  /** A paragraph's inline content, adjacent text with the same marks joined. */
  private inline(children: readonly WmlInline[]): TreeNode[] {
    this.#out = [];
    for (const child of children)
      if (child.kind === "run") this.run(child.rPr, this.piecesOfRun(child.pieces), null);
      else this.inlineElement(child.node, null);
    const joined: TreeNode[] = [];
    for (const node of this.#out) {
      const last = joined.at(-1);
      if (
        last?.type === "text" &&
        node.type === "text" &&
        JSON.stringify(last.marks ?? []) === JSON.stringify(node.marks ?? [])
      )
        joined[joined.length - 1] = { ...last, text: `${last.text}${node.text}` };
      else if (last?.type === "inlineMath" && node.type === "inlineMath")
        joined[joined.length - 1] = {
          ...last,
          attrs: { latex: `${String(last.attrs?.latex)}${String(node.attrs?.latex)}` },
        };
      else joined.push(node);
    }
    return joined;
  }

  // -------------------------------------------------------------------------
  // Blocks

  /** What one paragraph is, before neighbours group into lists, code and callouts. */
  private classify(
    paragraph: WmlParagraph,
    inline: readonly TreeNode[],
    original: WmlParagraph = paragraph,
  ): Classified {
    const style = getParagraphStyle(paragraph);
    const name = this.styleName(style);
    const own = (local: string) => childNamed(paragraph.pPr, local);
    const outline = own("outlineLvl") ?? this.styleProperty(style, "outlineLvl");
    const outlineLevel = outline ? Number(attributeOf(outline, "val")) : Number.NaN;
    const named = /^heading (\d)$/.exec(name);
    const level =
      outlineLevel >= 0 && outlineLevel <= 8
        ? outlineLevel + 1
        : named
          ? Number(named[1])
          : name === "title"
            ? 1
            : null;
    if (level) return { kind: "heading", level: Math.min(6, level) };
    const text = inline.map((node) => node.text ?? "").join("");
    const checked = !text.startsWith(TASK_BOXES.open);
    const numPr = own("numPr") ?? this.styleProperty(style, "numPr");
    const numId = numPr && attributeOf(childNamed(numPr, "numId") ?? numPr, "val");
    const ind = own("ind");
    const indent =
      Number((ind && (attributeOf(ind, "left") ?? attributeOf(ind, "start"))) ?? 0) || 0;
    if (numId && numId !== "0") {
      const ilvl = Number(attributeOf(childNamed(numPr, "ilvl") ?? numPr, "val") ?? 0) || 0;
      const format = this.#numbering(numId, ilvl);
      if (format) {
        if (TASK_START.test(text)) return { kind: "task", level: ilvl, checked };
        if (format.bullet) return { kind: "bullet", level: ilvl, number: 1 };
        let number = this.#numbers.get(original);
        if (number === undefined) {
          number = this.count(numId, ilvl, format.start);
          this.#numbers.set(original, number);
        }
        return { kind: "ordered", level: ilvl, number };
      }
    }
    if (TASK_START.test(text)) return { kind: "task", level: levelOf(indent), checked };
    const shading = own("shd");
    const fill = shading && attributeOf(shading, "fill");
    const shaded = !!fill && !/^(?:auto|ffffff)$/i.test(fill);
    const borders = own("pBdr");
    const framed = shaded && !!childNamed(borders, "left");
    const words = inline.filter((node) => node.type === "text" || node.type === "hardBreak");
    const allCode =
      words.length > 0 &&
      words.every(
        (node) => node.type === "hardBreak" || node.marks?.some((mark) => mark.type === "code"),
      );
    if (CODE_STYLES.test(name) || (shaded && allCode && !framed)) return { kind: "code" };
    if (framed) {
      const label = inline.length === 1 ? CALLOUTS.get(text.trim().toLowerCase()) : undefined;
      return { kind: "calloutPart", label: label ?? null };
    }
    if (QUOTE_STYLES.test(name)) return { kind: "quote" };
    if (!inline.length && childNamed(borders, "bottom")) return { kind: "rule" };
    const math = inline.length > 0 && inline.every((node) => node.type === "inlineMath");
    if (math && getParagraphAlignment(paragraph) === "center") return { kind: "math" };
    return { kind: "paragraph", level: indent >= LEVEL_TWIPS ? levelOf(indent) : null };
  }

  private codeText(inline: readonly TreeNode[]) {
    return inline.flatMap((node): TreeNode[] => {
      if (node.type === "hardBreak") return [{ type: "text", text: "\n" }];
      if (node.type !== "text") return [];
      const marks = node.marks?.filter((mark) => mark.type === "comment");
      return [{ type: "text", text: node.text ?? "", ...(marks?.length ? { marks } : {}) }];
    });
  }

  /** Body or cell blocks as document blocks; `top` is the body, where callouts may start. */
  private blocks(items: readonly WmlBlock[], top: boolean): TreeNode[] {
    return this.group(this.entries(items), top);
  }

  /** Each block read once, in order: inline content moves comment ranges, fields and counts. */
  private entries(items: readonly WmlBlock[]): Entry[] {
    const entries: Entry[] = [];
    for (const item of items) {
      if (item.kind === "table") {
        const table = this.table(item);
        if (table) entries.push({ kind: "block", nodes: [table] });
        continue;
      }
      if (item.kind === "raw") {
        entries.push({ kind: "block", nodes: this.rawBlock(item.node) });
        continue;
      }
      const tocBefore = this.#toc;
      const inline = this.inline(item.children);
      // A table of contents' entries are Word's to rebuild from the headings, not text.
      if (tocBefore || this.#toc) continue;
      // A paragraph holding only a page break is layout.
      const pageBreak =
        !inline.length &&
        item.children.some(
          (child) => child.kind === "run" && child.pieces.some((piece) => piece.kind === "break"),
        );
      if (pageBreak) continue;
      entries.push({ kind: "paragraph", paragraph: item, inline, is: this.classify(item, inline) });
    }
    return entries;
  }

  private group(entries: readonly Entry[], top: boolean): TreeNode[] {
    const out: TreeNode[] = [];
    for (let index = 0; index < entries.length;) {
      const entry = entries[index]!;
      if (entry.kind === "block") {
        out.push(...entry.nodes);
        index += 1;
        continue;
      }
      const { is, inline } = entry;
      /** The run of neighbours of one kind, starting here. */
      const same = (kind: Classified["kind"]) => {
        const run: ParagraphEntry[] = [];
        for (let next = entries[index]; next?.kind === "paragraph" && next.is.kind === kind;) {
          run.push(next);
          index += 1;
          next = entries[index];
        }
        return run;
      };
      switch (is.kind) {
        case "heading":
          out.push({ type: "heading", attrs: { level: is.level }, ...paragraphContent(inline) });
          index += 1;
          break;
        case "code": {
          const lines = same("code").map((each) => this.codeText(each.inline));
          const joined: TreeNode[] = [];
          for (const node of lines.flatMap((line, at) =>
            at ? [{ type: "text", text: "\n" }, ...line] : line,
          )) {
            const last = joined.at(-1);
            if (last && JSON.stringify(last.marks ?? []) === JSON.stringify(node.marks ?? []))
              joined[joined.length - 1] = { ...last, text: `${last.text}${node.text}` };
            else joined.push(node);
          }
          out.push({ type: "codeBlock", ...(joined.length ? { content: joined } : {}) });
          break;
        }
        case "quote":
          out.push({
            type: "blockquote",
            content: same("quote").map((each) => paragraphNode(each.inline)),
          });
          break;
        case "rule":
          out.push({ type: "horizontalRule" });
          index += 1;
          break;
        case "math":
          out.push({
            type: "blockMath",
            attrs: { latex: inline.map((node) => String(node.attrs?.latex ?? "")).join("") },
          });
          index += 1;
          break;
        case "calloutPart": {
          index += 1;
          if (!top || !is.label) {
            out.push(paragraphNode(inline));
            break;
          }
          // What follows inside the frame, each read as what it is apart from the frame.
          const members: Entry[] = [];
          for (let next = entries[index]; next?.kind === "paragraph"; next = entries[index]) {
            const framed = this.framed(next.paragraph);
            if (!framed || (next.is.kind === "calloutPart" && next.is.label)) break;
            members.push({
              ...next,
              is: this.classify(this.unframed(next.paragraph), next.inline, next.paragraph),
            });
            index += 1;
          }
          const inner = this.group(members, false);
          out.push({
            type: "callout",
            attrs: { kind: is.label },
            content: inner.length ? inner : [{ type: "paragraph" }],
          });
          break;
        }
        case "bullet":
        case "ordered":
        case "task": {
          const read = this.list(entries, index);
          out.push(...read.nodes);
          index = read.next;
          break;
        }
        default:
          out.push(paragraphNode(inline));
          index += 1;
      }
    }
    return out;
  }

  /** Whether a paragraph carries a callout's frame, as a list or code inside one does too. */
  private framed(paragraph: WmlParagraph) {
    return (
      !!childNamed(childNamed(paragraph.pPr, "pBdr"), "left") && !!childNamed(paragraph.pPr, "shd")
    );
  }
  /** The paragraph without a callout's frame, so it is read as what it holds. */
  private unframed(paragraph: WmlParagraph): WmlParagraph {
    if (!paragraph.pPr) return paragraph;
    return {
      ...paragraph,
      pPr: {
        ...paragraph.pPr,
        children: paragraph.pPr.children.filter(
          (child) =>
            !(
              child.kind === "element" &&
              (child.name.local === "pBdr" || child.name.local === "shd")
            ),
        ),
      },
    };
  }

  /**
   * Consecutive list paragraphs as nested lists: a deeper level opens a list
   * inside the item before it, and an indented paragraph continues the item
   * at its depth.
   */
  private list(entries: readonly Entry[], from: number) {
    const root: TreeNode[] = [];
    const stack: Array<{ list: TreeNode; level: number; kind: string }> = [];
    let index = from;
    for (; index < entries.length; index++) {
      const entry = entries[index]!;
      if (entry.kind !== "paragraph") break;
      const { is } = entry;
      if (is.kind === "paragraph" && is.level !== null && stack.length) {
        const depth = is.level;
        const holder = stack.findLast((open) => open.level <= depth) ?? stack[0]!;
        holder.list.content!.at(-1)!.content!.push({
          type: "paragraph",
          ...paragraphContent(entry.inline),
        });
        continue;
      }
      if (is.kind !== "bullet" && is.kind !== "ordered" && is.kind !== "task") break;
      const level = Math.min(is.level, 8);
      while (stack.length && stack.at(-1)!.level > level) stack.pop();
      let top = stack.at(-1);
      if (top && top.level === level && top.kind !== is.kind) {
        stack.pop();
        top = stack.at(-1);
      }
      if (!top || top.level < level) {
        const list: TreeNode =
          is.kind === "bullet"
            ? { type: "bulletList", content: [] }
            : is.kind === "task"
              ? { type: "taskList", content: [] }
              : { type: "orderedList", attrs: { start: is.number }, content: [] };
        const parent = top?.list.content!.at(-1);
        if (parent) parent.content!.push(list);
        else root.push(list);
        top = { list, level, kind: is.kind };
        stack.push(top);
      }
      let inline = entry.inline;
      if (is.kind === "task") {
        const [first, ...rest] = inline;
        const stripped = first?.type === "text" ? (first.text ?? "").replace(TASK_START, "") : "";
        inline = stripped && first ? [{ ...first, text: stripped }, ...rest] : rest;
      }
      top.list.content!.push({
        type: is.kind === "task" ? "taskItem" : "listItem",
        ...(is.kind === "task" ? { attrs: { checked: is.checked } } : {}),
        content: [{ type: "paragraph", ...paragraphContent(inline) }],
      });
    }
    return { nodes: root, next: index };
  }

  private table(table: WmlTable): TreeNode | null {
    const repeated = table.rows[0]?.trPr && childNamed(table.rows[0].trPr, "tblHeader");
    const headerRow = !!repeated && isOn(repeated);
    // A vertically merged cell is one cell spanning rows, found by its grid column.
    const above = new Map<number, TreeNode>();
    const rows = table.rows.map((row, rowIndex): TreeNode => {
      const cells: TreeNode[] = [];
      let column = 0;
      for (const cell of row.cells) {
        const gridSpan = childNamed(cell.tcPr, "gridSpan");
        const span = Math.max(1, Number(gridSpan && attributeOf(gridSpan, "val")) || 1);
        const merge = childNamed(cell.tcPr, "vMerge");
        const restart = merge && attributeOf(merge, "val") === "restart";
        if (merge && !restart) {
          const spanning = above.get(column);
          if (spanning)
            spanning.attrs = {
              ...spanning.attrs,
              rowspan: Number(spanning.attrs?.rowspan ?? 1) + 1,
            };
          column += span;
          continue;
        }
        const nested = cell.extras.filter(
          (extra) => extra.node.kind === "element" && extra.node.name.local === "tbl",
        );
        const header = headerRow && rowIndex === 0;
        // A header row's bold is the header's look, which the export writes too.
        const content = header
          ? this.blocks(cell.paragraphs, false).map(withoutBold)
          : this.blocks(cell.paragraphs, false);
        for (const extra of nested) {
          this.lose("tables inside tables, kept as their text");
          if (extra.node.kind === "element")
            for (const line of elementsNamed(extra.node, "tr"))
              content.push({
                type: "paragraph",
                content: [
                  { type: "text", text: elementsNamed(line, "tc").map(xmlText).join(" | ") },
                ],
              });
        }
        const made: TreeNode = {
          type: header ? "tableHeader" : "tableCell",
          attrs: { colspan: span, rowspan: 1 },
          content: content.length ? content : [{ type: "paragraph" }],
        };
        if (restart) above.set(column, made);
        else above.delete(column);
        cells.push(made);
        column += span;
      }
      return { type: "tableRow", content: cells };
    });
    const kept = rows.filter((row) => row.content!.length);
    return kept.length ? { type: "table", content: kept } : null;
  }

  /** A block the library keeps as markup: a content control's paragraphs as text. */
  private rawBlock(node: XmlElement): TreeNode[] {
    const gallery = elementsNamed(node, "docPartGallery")[0];
    const isToc =
      (gallery && /table of contents/i.test(attributeOf(gallery, "val") ?? "")) ||
      elementsNamed(node, "instrText").some((each) =>
        /^\s*TOC\b/.test(xmlText({ ...each, name: { ...each.name, local: "t" } })),
      );
    if (isToc) {
      this.lose("a table of contents, which Word rebuilds from the headings");
      return [];
    }
    return elementsNamed(node, "p").flatMap((paragraph) => {
      const text = xmlText(paragraph);
      return text ? [{ type: "paragraph", content: [{ type: "text", text }] }] : [];
    });
  }
}
