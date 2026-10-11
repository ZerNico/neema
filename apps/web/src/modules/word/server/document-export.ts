// Loaded by the Word worker under plain Node in development: relative imports only.
import {
  addBulletList,
  addComment,
  addFootnote,
  addHyperlink,
  addNumberedList,
  addTable,
  applyListToParagraph,
  commentsPart,
  createDocx,
  getParagraphNumbering,
  insertImageInto,
  numberingPart,
  setParagraphAlignment,
  setParagraphBorders,
  setParagraphIndent,
  setParagraphShading,
  setParagraphStyle,
  setTableBorders,
  setTableRowAsHeader,
  setTitle,
  stylesPart,
  type Docx,
  type WmlBlock,
  type WmlInline,
  type WmlParagraph,
  type WmlRun,
  type WmlRunPiece,
  type WmlTableCell,
  type WmlTableRow,
} from "@office-kit/docx";
import {
  ORDER,
  attributeOf,
  builtInStyle,
  childNamed,
  element,
  save,
  withChild,
  type XmlElement,
} from "./adapter.ts";
import type { DocumentForWord, TreeMark, TreeNode, WordThread } from "./document-tree.ts";
import { pictureOf } from "./picture.ts";

/** The font Word itself uses for code, and the one formulas are written in so they read back as formulas. */
export const CODE_FONT = "Consolas";
export const MATH_FONT = "Cambria Math";
/** Shading behind a code block or a callout, and a header cell. */
const BLOCK_FILL = "F4F4F5";
const HEADER_FILL = "F2F2F2";
const LINK_COLOR = "0563C1";
/** An A4 page's text width with Word's normal margins, in twips; images are capped at it. */
const TEXT_WIDTH_TWIPS = 9026;
const TEXT_WIDTH_PX = 604;
const EMU_PER_PX = 9_525;
/** One list level's indent, as the library's own numbering indents it. */
export const LEVEL_TWIPS = 720;

export const CALLOUT_LABELS: Record<string, { label: string; color: string }> = {
  note: { label: "Note", color: "2563EB" },
  tip: { label: "Tip", color: "16A34A" },
  important: { label: "Important", color: "7C3AED" },
  warning: { label: "Warning", color: "D97706" },
  caution: { label: "Caution", color: "DC2626" },
};
/** How a task item starts in Word, which has no checkbox a plain paragraph can hold. */
export const TASK_BOXES = { open: "☐", done: "☑" } as const;

interface Format {
  bold?: true;
  italic?: true;
  strike?: true;
  underline?: true;
  highlight?: true;
  font?: string;
  color?: string;
}

/** A link a reader may follow: web and mail only. */
const safeHref = (href: unknown) => {
  if (typeof href !== "string" || !/^(?:https?:|mailto:)/i.test(href)) return null;
  try {
    return new URL(href).href;
  } catch {
    return null;
  }
};

const formatOf = (marks: readonly TreeMark[] = [], base: Format = {}): Format => {
  const format: Format = { ...base };
  for (const mark of marks)
    if (mark.type === "bold") format.bold = true;
    else if (mark.type === "italic") format.italic = true;
    else if (mark.type === "strike") format.strike = true;
    else if (mark.type === "underline") format.underline = true;
    else if (mark.type === "highlight") format.highlight = true;
    else if (mark.type === "code") format.font = CODE_FONT;
  return format;
};

/** Run properties in the order Word reads them (`ORDER.rPr`). */
const runProperties = (format: Format): XmlElement | undefined => {
  const children: XmlElement[] = [];
  if (format.font) children.push(element("rFonts", { ascii: format.font, hAnsi: format.font }));
  if (format.bold) children.push(element("b"));
  if (format.italic) children.push(element("i"));
  if (format.strike) children.push(element("strike"));
  if (format.color) children.push(element("color", { val: format.color }));
  if (format.highlight) children.push(element("highlight", { val: "yellow" }));
  if (format.underline) children.push(element("u", { val: "single" }));
  return children.length ? element("rPr", {}, children) : undefined;
};

/** Text as run pieces: tabs and line breaks are elements of their own in Word. */
const piecesOf = (text: string): WmlRunPiece[] =>
  text.split(/(\t|\r?\n)/).flatMap((part): WmlRunPiece[] => {
    if (part === "\t") return [{ kind: "tab" }];
    if (part === "\n" || part === "\r\n") return [{ kind: "break" }];
    return part ? [{ kind: "text", value: part, preserveSpace: /^\s|\s$/.test(part) }] : [];
  });

const runOf = (text: string, format: Format): WmlRun => {
  const rPr = runProperties(format);
  return { kind: "run", ...(rPr ? { rPr } : {}), pieces: piecesOf(text), extras: [] };
};

const XML_SPACE = { uri: "http://www.w3.org/XML/1998/namespace", local: "space", prefix: "xml" };
/** A run as raw XML, for inside a hyperlink, which the library keeps as raw markup. */
const runElement = (run: WmlRun): XmlElement =>
  element("r", {}, [
    ...(run.rPr ? [run.rPr] : []),
    ...run.pieces.flatMap((piece) => {
      if (piece.kind === "tab") return [element("tab")];
      if (piece.kind === "break") return [element("br")];
      if (piece.kind !== "text") return [];
      const text = element("t", {}, [{ kind: "text", value: piece.value }]);
      return [
        piece.preserveSpace
          ? {
              ...text,
              attrs: [{ name: XML_SPACE, value: "preserve", isNamespaceDecl: false }],
              xmlSpace: "preserve" as const,
            }
          : text,
      ];
    }),
  ]);

/** A picture's pixel size from its own bytes: PNG and JPEG by `pictureOf`, GIF here. */
const imageOf = (bytes: Uint8Array) => {
  const picture = pictureOf(bytes);
  if (picture) return picture;
  const gif = bytes.length > 10 && String.fromCharCode(...bytes.subarray(0, 4)) === "GIF8";
  if (!gif) return null;
  return {
    mediaType: "image/gif",
    width: bytes[6]! | (bytes[7]! << 8),
    height: bytes[8]! | (bytes[9]! << 8),
  };
};

const pixels = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)
      ? Number(value)
      : null;

/** What an inline node reads as in a run, or null for one that is not text. */
const textOf = (node: TreeNode): string | null => {
  switch (node.type) {
    case "text":
      return node.text ?? "";
    case "hardBreak":
      return "\n";
    case "dateChip":
      return typeof node.attrs?.value === "string" ? node.attrs.value : "";
    case "mention": {
      const label = node.attrs?.label ?? node.attrs?.id;
      return typeof label === "string" && label ? `@${label}` : "";
    }
    case "inlineMath":
      return typeof node.attrs?.latex === "string" ? node.attrs.latex : "";
    default:
      return null;
  }
};
/** A text node\'s run format; a formula is written in the math font so it reads back as one. */
const inlineFormat = (node: TreeNode, base: Format) =>
  node.type === "inlineMath"
    ? { ...formatOf(node.marks, base), font: MATH_FONT }
    : formatOf(node.marks, base);

/** A node's text, for a table nested in a cell, which is written as text. */
const plainText = (node: TreeNode): string =>
  node.type === "text" ? (node.text ?? "") : (node.content ?? []).map(plainText).join("");

/** How many columns or rows a table cell spans. */
const spanOf = (cell: TreeNode, key: "colspan" | "rowspan") =>
  Math.max(1, Math.floor(Number(cell.attrs?.[key] ?? 1)) || 1);

/** Where blocks go and how the paragraphs made there look. */
interface Scope {
  put: (block: WmlBlock) => void;
  inCell: boolean;
  /** Left indent for paragraphs that continue a list item, in twips. */
  indent: number;
  depth: number;
  quote: boolean;
  callout: string | null;
  /** Header cells' text is bold. */
  bold: boolean;
}

interface OpenComment {
  readonly end: WmlInline;
  readonly reference: WmlInline;
  paragraph: WmlParagraph | null;
  after: WmlInline | null;
}

/**
 * A live document as a Word file: headings in Word's built-in heading styles,
 * so a table of contents finds them, real lists, tables, footnotes, pictures
 * and comments. What Word has no place for is written as text (formulas as
 * their LaTeX, dates and people as they read).
 */
export function documentToWord(input: DocumentForWord): Uint8Array {
  const doc = createDocx({ paragraphs: [] });
  setTitle(doc, input.title);
  const threads = new Map(input.threads.map((thread) => [thread.id, thread]));
  const comments = new Map<string, OpenComment>();
  const headings = new Set<number>();
  let bullets: number | null = null;
  let numbered: { abstract: string } | null = null;

  /** A list paragraph the library makes, taken out of the body again, for its numbering id. */
  const listNumbering = (make: (doc: Docx, items: string[]) => WmlParagraph[]) => {
    const [carrier] = make(doc, [""]);
    const blocks = doc.document.body.blocks;
    blocks.splice(blocks.indexOf(carrier!), 1);
    return getParagraphNumbering(carrier!)!.numId;
  };
  const bulletList = () => (bullets ??= listNumbering(addBulletList));
  /**
   * Each numbered list counts from its own start: Word carries a count on
   * through every list of one definition unless a list says where it starts.
   */
  const numberedList = (start: number, level: number) => {
    const part = () => numberingPart(doc)!;
    if (!numbered) {
      const id = listNumbering(addNumberedList);
      const num = part().nums.find((each) => attributeOf(each, "numId") === String(id));
      numbered = { abstract: attributeOf(childNamed(num, "abstractNumId")!, "val")! };
    }
    const used = part().nums.map((each) => Number(attributeOf(each, "numId")));
    const id = Math.max(0, ...used) + 1;
    part().nums.push(
      element("num", { numId: String(id) }, [
        element("abstractNumId", { val: numbered.abstract }),
        element("lvlOverride", { ilvl: String(level) }, [
          element("startOverride", { val: String(start) }),
        ]),
      ]),
    );
    doc.numberingDirty = true;
    return id;
  };

  const paragraph = (scope: Scope, options: { indent?: boolean } = {}): WmlParagraph => {
    const made: WmlParagraph = { kind: "paragraph", children: [], extras: [] };
    if (scope.quote) setParagraphStyle(made, builtInStyle(doc, "quote"));
    if (scope.indent && options.indent !== false) setParagraphIndent(made, { left: scope.indent });
    if (scope.callout) {
      const look = CALLOUT_LABELS[scope.callout] ?? CALLOUT_LABELS.note!;
      setParagraphBorders(made, {
        sides: ["left"],
        sizeEighthsOfPoint: 18,
        color: look.color,
        spacePt: 8,
      });
      setParagraphShading(made, { fill: BLOCK_FILL });
    }
    scope.put(made);
    return made;
  };

  /** Starts a thread's Word comment just before `at`'s next child. */
  const startComment = (at: WmlParagraph, thread: WordThread) => {
    const scratch: WmlParagraph = { kind: "paragraph", children: [], extras: [] };
    addComment(doc, scratch, {
      author: thread.author || "Someone",
      text: "",
      ...(thread.date ? { date: thread.date } : {}),
    });
    // One Word paragraph per line, since a line break inside one text reads as a space.
    const part = commentsPart(doc)!;
    const comment = part.comments.at(-1)!;
    part.comments[part.comments.length - 1] = {
      ...comment,
      children: thread.text
        .split("\n")
        .map((line) => element("p", {}, line ? [runElement(runOf(line, {}))] : [])),
      selfClosing: false,
    };
    const [start, end, reference] = scratch.children;
    at.children.push(start!);
    const open: OpenComment = { end: end!, reference: reference!, paragraph: null, after: null };
    comments.set(thread.id, open);
    return open;
  };

  const threadsOf = (node: TreeNode) =>
    (node.marks ?? []).flatMap((mark) => {
      const id = mark.type === "comment" ? mark.attrs?.thread : undefined;
      return typeof id === "string" && threads.has(id) ? [id] : [];
    });

  /** Adds what `make` appends to `at`, inside the comments of `ids`. */
  const commented = (at: WmlParagraph, ids: readonly string[], make: () => void) => {
    for (const id of ids) if (!comments.has(id)) startComment(at, threads.get(id)!);
    const before = at.children.length;
    make();
    const last = at.children.at(-1);
    if (at.children.length === before || !last) return;
    for (const id of ids) {
      const open = comments.get(id)!;
      open.paragraph = at;
      open.after = last;
    }
  };

  const picture = (at: WmlParagraph, node: TreeNode) => {
    const src = typeof node.attrs?.src === "string" ? node.attrs.src : "";
    const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
    const bytes = input.images[src];
    const kind = bytes ? imageOf(bytes) : null;
    if (bytes && kind && kind.width > 0 && kind.height > 0) {
      const wanted = pixels(node.attrs?.width);
      const width = Math.min(TEXT_WIDTH_PX, wanted ?? kind.width);
      const height = pixels(node.attrs?.height) ?? (width * kind.height) / kind.width;
      insertImageInto(doc, at, bytes, {
        widthEmu: Math.round(width * EMU_PER_PX),
        heightEmu: Math.round(height * EMU_PER_PX),
        contentType: kind.mediaType,
        ...(alt ? { altText: alt } : {}),
      });
      return;
    }
    // A picture from the web stays where it was as a link to it; anything else is left out.
    const href = /^https?:/i.test(src) ? safeHref(src) : null;
    if (href) hyperlink(at, href, [runOf(alt || href, {})]);
  };

  const hyperlink = (at: WmlParagraph, href: string, runs: WmlRun[]) => {
    const carrier = addHyperlink(doc, href, "");
    const blocks = doc.document.body.blocks;
    blocks.splice(blocks.indexOf(carrier), 1);
    const link = carrier.children[0];
    if (link?.kind !== "raw") return;
    at.children.push({
      kind: "raw",
      node: { ...link.node, children: runs.map(runElement), selfClosing: false },
    });
  };

  const inline = (at: WmlParagraph, nodes: readonly TreeNode[] = [], base: Format = {}) => {
    for (let index = 0; index < nodes.length;) {
      const node = nodes[index]!;
      const link = node.marks?.find((mark) => mark.type === "link");
      const href = link ? safeHref(link.attrs?.href) : null;
      if (href && textOf(node) !== null) {
        // Neighbouring text with the same address is one link, however its formatting changes.
        const group: TreeNode[] = [];
        while (index < nodes.length) {
          const next = nodes[index]!;
          const nextLink = next.marks?.find((mark) => mark.type === "link");
          if (textOf(next) === null || !nextLink || safeHref(nextLink.attrs?.href) !== href) break;
          group.push(next);
          index += 1;
        }
        const ids = [...new Set(group.flatMap(threadsOf))];
        commented(at, ids, () =>
          hyperlink(
            at,
            href,
            group.map((each) =>
              runOf(textOf(each)!, {
                ...inlineFormat(each, base),
                color: LINK_COLOR,
                underline: true,
              }),
            ),
          ),
        );
        continue;
      }
      index += 1;
      const text = textOf(node);
      if (text !== null) {
        if (text)
          commented(at, threadsOf(node), () =>
            at.children.push(runOf(text, inlineFormat(node, base))),
          );
        continue;
      }
      if (node.type === "image") picture(at, node);
      else if (node.type === "footnote") {
        const note = typeof node.attrs?.note === "string" ? node.attrs.note.trim() : "";
        if (note) addFootnote(doc, at, note);
      }
    }
  };

  const list = (node: TreeNode, scope: Scope) => {
    const level = Math.min(scope.depth, 8);
    const task = node.type === "taskList";
    const numId = task
      ? null
      : node.type === "orderedList"
        ? numberedList(Math.max(0, Number(node.attrs?.start ?? 1) || 0), level)
        : bulletList();
    for (const item of node.content ?? []) {
      const [first, ...rest] = item.content ?? [];
      const made = paragraph(scope, { indent: false });
      if (numId !== null) applyListToParagraph(doc, made, numId, level);
      else {
        setParagraphIndent(made, { left: LEVEL_TWIPS * (level + 1), hanging: 360 });
        made.children.push(
          runOf(`${item.attrs?.checked ? TASK_BOXES.done : TASK_BOXES.open} `, {}),
        );
      }
      if (first?.type === "paragraph")
        inline(made, first.content, scope.bold ? { bold: true } : {});
      else if (first) block(first, { ...scope, depth: scope.depth + 1 });
      const inner = { ...scope, depth: scope.depth + 1, indent: LEVEL_TWIPS * (level + 1) };
      for (const child of rest) block(child, inner);
    }
  };

  const tableCell = (
    node: TreeNode | null,
    width: number,
    span: number,
    merge: "restart" | "continue" | null,
    header: boolean,
  ): WmlTableCell => {
    const paragraphs: WmlParagraph[] = [];
    if (node && merge !== "continue") {
      const inner: Scope = {
        put: (made) => {
          if (made.kind === "paragraph") paragraphs.push(made);
        },
        inCell: true,
        indent: 0,
        depth: 0,
        quote: false,
        callout: null,
        bold: header,
      };
      for (const child of node.content ?? []) block(child, inner);
    }
    if (!paragraphs.length) paragraphs.push({ kind: "paragraph", children: [], extras: [] });
    const properties: XmlElement[] = [element("tcW", { w: String(width * span), type: "dxa" })];
    if (span > 1) properties.push(element("gridSpan", { val: String(span) }));
    if (merge) properties.push(element("vMerge", merge === "restart" ? { val: "restart" } : {}));
    if (header) properties.push(element("shd", { val: "clear", color: "auto", fill: HEADER_FILL }));
    return { tcPr: element("tcPr", {}, properties), paragraphs, extras: [] };
  };

  const table = (node: TreeNode, scope: Scope) => {
    const rows = node.content ?? [];
    // A table inside a table cell is written as its rows of text, which a cell cannot nest here.
    if (scope.inCell) {
      for (const row of rows) {
        const made = paragraph(scope);
        made.children.push(
          runOf((row.content ?? []).map((cell) => plainText(cell)).join(" | "), {}),
        );
      }
      return;
    }
    // Word's grid: a cell spanning rows leaves a merged cell in each row below it.
    type Slot =
      | { kind: "cell"; node: TreeNode; colspan: number; rowspan: number }
      | { kind: "continue"; span: number }
      | { kind: "empty" };
    const cover: Array<{ until: number; span: number } | undefined> = [];
    const layout = rows.map((row, rowIndex) => {
      const slots: Slot[] = [];
      const source = [...(row.content ?? [])];
      let column = 0;
      for (;;) {
        const above = cover[column];
        if (above && above.until > rowIndex) {
          slots.push({ kind: "continue", span: above.span });
          column += above.span;
          continue;
        }
        const cell = source.shift();
        if (!cell) break;
        const colspan = spanOf(cell, "colspan");
        const rowspan = spanOf(cell, "rowspan");
        if (rowspan > 1) cover[column] = { until: rowIndex + rowspan, span: colspan };
        slots.push({ kind: "cell", node: cell, colspan, rowspan });
        column += colspan;
      }
      // Rows above may still cover columns past this row's last cell.
      cover.forEach((above, start) => {
        if (!above || above.until <= rowIndex || start < column) return;
        for (; column < start; column++) slots.push({ kind: "empty" });
        slots.push({ kind: "continue", span: above.span });
        column += above.span;
      });
      return { slots, width: column };
    });
    const columns = Math.max(1, ...layout.map((row) => row.width));
    const made = addTable(doc, [Array.from({ length: columns }, () => "")], {
      totalWidthTwips: TEXT_WIDTH_TWIPS,
    });
    const blocks = doc.document.body.blocks;
    blocks.splice(blocks.indexOf(made), 1);
    setTableBorders(made, { color: "BFBFBF" });
    const width = Math.floor(TEXT_WIDTH_TWIPS / columns);
    const headerRow = (rows[0]?.content ?? []).every((cell) => cell.type === "tableHeader");
    made.rows = layout.map(({ slots, width: used }): WmlTableRow => {
      const cells = slots.map((slot) =>
        slot.kind === "cell"
          ? tableCell(
              slot.node,
              width,
              slot.colspan,
              slot.rowspan > 1 ? "restart" : null,
              slot.node.type === "tableHeader",
            )
          : slot.kind === "continue"
            ? tableCell(null, width, slot.span, "continue", false)
            : tableCell(null, width, 1, null, false),
      );
      for (let column = used; column < columns; column++)
        cells.push(tableCell(null, width, 1, null, false));
      return { cells, extras: [] };
    });
    if (headerRow && made.rows[0]) setTableRowAsHeader(made.rows[0]);
    scope.put(made);
  };

  const block = (node: TreeNode, scope: Scope): void => {
    switch (node.type) {
      case "paragraph":
        inline(paragraph(scope), node.content, scope.bold ? { bold: true } : {});
        return;
      case "heading": {
        const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1) || 1));
        const made = paragraph({ ...scope, quote: false });
        setParagraphStyle(made, builtInStyle(doc, `heading${level}` as "heading1"));
        headings.add(level);
        inline(made, node.content);
        return;
      }
      case "blockquote":
        for (const child of node.content ?? []) block(child, { ...scope, quote: true });
        return;
      case "codeBlock": {
        const made = paragraph(scope);
        if (!scope.callout) setParagraphShading(made, { fill: BLOCK_FILL });
        inline(made, node.content, { font: CODE_FONT });
        return;
      }
      case "bulletList":
      case "orderedList":
      case "taskList":
        list(node, scope);
        return;
      case "table":
        table(node, scope);
        return;
      case "horizontalRule": {
        const made = paragraph(scope);
        setParagraphBorders(made, {
          sides: ["bottom"],
          sizeEighthsOfPoint: 6,
          color: "A1A1AA",
          spacePt: 1,
        });
        return;
      }
      case "blockMath": {
        const latex = typeof node.attrs?.latex === "string" ? node.attrs.latex : "";
        const made = paragraph(scope);
        setParagraphAlignment(made, "center");
        if (latex) made.children.push(runOf(latex, { font: MATH_FONT }));
        return;
      }
      case "callout": {
        const kind =
          typeof node.attrs?.kind === "string" && node.attrs.kind in CALLOUT_LABELS
            ? node.attrs.kind
            : "note";
        const inner = { ...scope, callout: kind };
        const look = CALLOUT_LABELS[kind]!;
        paragraph(inner).children.push(runOf(look.label, { bold: true, color: look.color }));
        for (const child of node.content ?? []) block(child, inner);
        return;
      }
      case "details": {
        const [summary, content] = node.content ?? [];
        if (summary) inline(paragraph(scope), summary.content, { bold: true });
        for (const child of content?.content ?? []) block(child, scope);
        return;
      }
      case "pending":
        return;
      default:
        // Markdown parsing leaves a picture alone on its line outside any paragraph.
        if (node.type === "image" || textOf(node) !== null) {
          inline(paragraph(scope), [node], scope.bold ? { bold: true } : {});
          return;
        }
        for (const child of node.content ?? []) block(child, scope);
    }
  };

  const body: Scope = {
    put: (made) => {
      doc.document.body.blocks.push(made);
    },
    inCell: false,
    indent: 0,
    depth: 0,
    quote: false,
    callout: null,
    bold: false,
  };
  for (const child of input.tree.content ?? []) block(child, body);

  // Each comment ends after the last of its text.
  for (const open of comments.values()) {
    if (!open.paragraph || !open.after) continue;
    const at = open.paragraph.children.indexOf(open.after);
    open.paragraph.children.splice(at + 1, 0, open.end, open.reference);
  }
  // A table of contents lists paragraphs by outline level, which the heading styles carry.
  const styles = stylesPart(doc);
  for (const level of headings) {
    const id = builtInStyle(doc, `heading${level}` as "heading1");
    const index = styles?.styles.findIndex((style) => attributeOf(style, "styleId") === id) ?? -1;
    if (!styles || index < 0) continue;
    let properties = childNamed(styles.styles[index], "pPr") ?? element("pPr");
    properties = withChild(properties, "keepNext", element("keepNext"), ORDER.pPr);
    properties = withChild(
      properties,
      "outlineLvl",
      element("outlineLvl", { val: String(level - 1) }),
      ORDER.pPr,
    );
    styles.styles[index] = withChild(styles.styles[index]!, "pPr", properties, ORDER.style);
    doc.stylesDirty = true;
  }
  orderProperties(doc);
  return save(doc);
}

/** Paragraph properties re-sorted into Word's order: the library's setters append. */
function orderProperties(doc: Docx) {
  const order: readonly string[] = ORDER.pPr;
  const rank = (node: XmlElement["children"][number]) => {
    const at = node.kind === "element" ? order.indexOf(node.name.local) : -1;
    return at < 0 ? order.length : at;
  };
  const sort = (paragraph: WmlParagraph) => {
    if (paragraph.pPr)
      paragraph.pPr = {
        ...paragraph.pPr,
        children: paragraph.pPr.children.toSorted((a, b) => rank(a) - rank(b)),
      };
  };
  for (const item of doc.document.body.blocks)
    if (item.kind === "paragraph") sort(item);
    else if (item.kind === "table")
      for (const row of item.rows) for (const cell of row.cells) cell.paragraphs.forEach(sort);
}
