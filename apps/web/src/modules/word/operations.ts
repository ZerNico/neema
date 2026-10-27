import {
  operationEngine,
  received,
  xmlSafe,
  type Definition as OfficeDefinition,
} from "../office/operations.ts";
import { WordError } from "./errors.ts";
import { WORD_LIMITS } from "./limits.ts";

/**
 * The one description of every Word edit. Validation, the JSON schema the
 * model is offered, the adapter's operation types and the activity's change
 * summary all derive from this table, as for every Office family.
 *
 * Blocks are the body's top-level paragraphs and tables, numbered from 0 as
 * inspect_word_file lists them for the revision being edited. A number inside
 * that revision means its block, so earlier operations in the same call never
 * shift it; a number past its end counts on into what the call has added.
 */
type OwnField =
  | { readonly type: "text"; readonly about: string }
  | { readonly type: "grid"; readonly about: string }
  /** A built-in style key (heading2), or the name of a style the document defines. */
  | { readonly type: "style"; readonly about: string }
  | { readonly type: "color"; readonly about: string }
  /** A picture reference; the tool swaps it for authorized bytes before the worker runs. */
  | { readonly type: "image"; readonly about: string };
type Definition = OfficeDefinition<OwnField>;

const block = {
  type: "integer",
  min: 0,
  max: WORD_LIMITS.blocks,
  about: "Block number from inspect_word_file.",
} as const;
const position = {
  before: { ...block, about: "Insert before this block." },
  after: { ...block, about: "Insert after this block." },
  at: {
    type: "string",
    max: 5,
    options: ["start", "end"],
    about: "Insert at the start or end of the document.",
  },
} as const;
export const PARAGRAPH_STYLES = [
  "normal",
  "title",
  "heading1",
  "heading2",
  "heading3",
  "heading4",
  "heading5",
  "heading6",
  "quote",
] as const;
const inline =
  "Inline **bold**, *italic*, `code` and [links](https://example.com) are formatted; a newline is a line break within the paragraph.";
const paragraph = {
  type: "object",
  about: "One paragraph.",
  fields: {
    text: { type: "text", about: `Paragraph text. ${inline}` },
    style: {
      type: "style",
      about:
        "Paragraph style: normal (default), title, heading1–heading6, quote, or the name of any paragraph style the document defines (inspect_word_file lists them).",
    },
    list: {
      type: "string",
      max: 8,
      options: ["bullet", "numbered"],
      about: "Make it a list item. Consecutive items of one kind form one list.",
    },
    level: { type: "integer", min: 0, max: 8, about: "List nesting level, 0 at the top." },
    align: {
      type: "string",
      max: 7,
      options: ["left", "center", "right", "justify"],
      about: "Alignment.",
    },
  },
  required: ["text"],
} as const;

const look = {
  font: { type: "string", max: 100, about: 'Font family, e.g. "Calibri".' },
  size: { type: "number", min: 4, max: 400, about: "Font size in points." },
  color: { type: "color", about: "Text colour as #RRGGBB." },
  bold: { type: "boolean", about: "Bold." },
  italic: { type: "boolean", about: "Italic." },
  underline: { type: "boolean", about: "Underlined." },
} as const;
const pageText = {
  mode: {
    type: "string",
    max: 7,
    options: ["replace", "append"],
    about:
      "replace (default) swaps the whole header or footer, logos included, for the text; append adds a line and keeps what is there.",
  },
} as const;

export const WORD_OPERATIONS = {
  replaceText: {
    about:
      "Replace every occurrence of exact text in the body, headers and footers, e.g. a {{placeholder}}. Fails if the text is not found. The replacement keeps the formatting where the match began.",
    fields: {
      find: { type: "string", max: 500, about: "Text to find, exactly." },
      replace: { type: "text", about: "Replacement text; may be empty." },
      matchCase: { type: "boolean", about: "Match upper and lower case exactly (default true)." },
    },
    required: ["find", "replace"],
    change: ["replaced text"],
  },
  setParagraph: {
    about: `Rewrite one paragraph's text, and optionally its style or alignment. ${inline}`,
    fields: {
      block,
      text: { type: "text", about: "The paragraph's new text." },
      style: paragraph.fields.style,
      align: paragraph.fields.align,
    },
    required: ["block"],
    change: ["rewrote", "paragraph"],
  },
  insertParagraphs: {
    about:
      "Insert paragraphs (headings, body text, list items) before or after a block, or at the start or end. Give exactly one of before, after or at.",
    fields: {
      ...position,
      paragraphs: {
        type: "list",
        of: paragraph,
        min: 1,
        max: 200,
        about: "Paragraphs in order.",
      },
    },
    required: ["paragraphs"],
    change: ["inserted", "passage"],
  },
  insertTable: {
    about:
      "Insert a table of text before or after a block, or at the start or end. The first row is a header row unless headerRow is false.",
    fields: {
      ...position,
      rows: { type: "grid", about: "Rows of cell text; every row has the same number of cells." },
      headerRow: {
        type: "boolean",
        about: "Format the first row as a repeating header (default true).",
      },
    },
    required: ["rows"],
    change: ["inserted", "table"],
  },
  insertPageBreak: {
    about: "Insert a page break before or after a block, or at the start or end.",
    fields: { ...position },
    required: [],
    change: ["inserted", "page break"],
  },
  removeBlocks: {
    about: "Remove paragraphs and tables by block number.",
    fields: {
      blocks: { type: "list", of: block, min: 1, max: 500, about: "Block numbers to remove." },
    },
    required: ["blocks"],
    change: ["removed content"],
  },
  setTableCell: {
    about: "Set one table cell's text; rows and columns count from 0, the header row included.",
    fields: {
      table: { ...block, about: "The table's block number." },
      row: { type: "integer", min: 0, max: 10_000, about: "Row, from 0." },
      column: { type: "integer", min: 0, max: 63, about: "Column, from 0." },
      text: { type: "text", about: "Cell text." },
    },
    required: ["table", "row", "column", "text"],
    change: ["filled", "table cell"],
  },
  addTableRows: {
    about: "Append rows to the end of a table.",
    fields: {
      table: { ...block, about: "The table's block number." },
      rows: { type: "grid", about: "Rows of cell text, as many cells as the table has columns." },
    },
    required: ["table", "rows"],
    change: ["extended", "table"],
  },
  removeTableRows: {
    about: "Remove table rows by number, counting from 0 with the header row.",
    fields: {
      table: { ...block, about: "The table's block number." },
      rows: {
        type: "list",
        of: { type: "integer", min: 0, max: 10_000, about: "Row number." },
        min: 1,
        max: 500,
        about: "Rows to remove.",
      },
    },
    required: ["table", "rows"],
    change: ["shortened", "table"],
  },
  insertImage: {
    about:
      "Insert a PNG or JPEG picture in a paragraph of its own, before or after a block, or at the start or end.",
    fields: {
      ...position,
      imageRef: {
        type: "image",
        about:
          "The picture: attachment:<id>, project:<id>@<version>, a skill image's skill: reference, or the working: reference copy_from_computer returned.",
      },
      width: {
        type: "number",
        min: 1,
        max: 40,
        about:
          "Width in centimetres; the height follows the picture's shape. By default its own size, at most the text width.",
      },
      altText: { type: "string", max: 500, about: "Description for screen readers." },
      caption: { type: "text", about: "Caption paragraph under the picture." },
      align: {
        type: "string",
        max: 6,
        options: ["left", "center", "right"],
        about: "Alignment; center by default.",
      },
    },
    required: ["imageRef"],
    change: ["inserted", "picture"],
  },
  insertTableOfContents: {
    about:
      "Insert a table of contents listing the heading1–heading6 paragraphs (their levels, not their look). Word fills in entries and page numbers when the file is opened.",
    fields: {
      ...position,
      levels: {
        type: "integer",
        min: 1,
        max: 9,
        about: "Deepest heading level listed; 3 by default.",
      },
    },
    required: [],
    change: ["inserted", "table of contents"],
  },
  setHeader: {
    about:
      "Set the text at the top of every page; replacing with empty text removes the header. To change words in an existing header and keep its logo, use replaceText.",
    fields: { text: { type: "text", about: "Header text." }, ...pageText },
    required: ["text"],
    change: ["set", "header"],
  },
  setFooter: {
    about:
      "Set the text at the bottom of every page, optionally with the page number; replacing with empty text and no page number removes the footer.",
    fields: {
      text: { type: "text", about: "Footer text, shown before the page number if there is one." },
      pageNumber: { type: "boolean", about: "Show the page number." },
      ...pageText,
    },
    required: ["text"],
    change: ["set", "footer"],
  },
  setPageNumbers: {
    about:
      "Show, restyle or remove page numbers. They go into the header or footer beside what is already there (a logo, a line of text), or a new one; calling it again replaces the numbers wherever they were, including ones Word added.",
    fields: {
      where: {
        type: "string",
        max: 6,
        options: ["footer", "header", "none"],
        about: "footer (default), header, or none to remove page numbers.",
      },
      text: {
        type: "string",
        max: 80,
        about:
          'What to show, with {page} for the number and {pages} for the total, e.g. "Page {page} of {pages}" or "- {page} -"; "{page}" by default.',
      },
      align: {
        type: "string",
        max: 6,
        options: ["left", "center", "right"],
        about: "Alignment; center by default.",
      },
      ...look,
      skipFirstPage: {
        type: "boolean",
        about: "No number (nor header or footer) on the first page, e.g. a cover.",
      },
      startAt: { type: "integer", min: 0, max: 10_000, about: "The first page's number." },
      numberStyle: {
        type: "string",
        max: 11,
        options: ["decimal", "lowerRoman", "upperRoman", "lowerLetter", "upperLetter"],
        about: "How numbers are written: 1, i, I, a or A.",
      },
    },
    required: [],
    change: ["set", "page numbering"],
  },
  setStyle: {
    about:
      "Change how a style looks everywhere it is used, e.g. every heading2. Give only the properties to change.",
    fields: {
      style: {
        type: "style",
        about:
          "The style: normal, title, heading1–heading6, quote, or the name of a paragraph style the document defines.",
      },
      ...look,
      align: {
        type: "string",
        max: 7,
        options: ["left", "center", "right", "justify"],
        about: "Alignment.",
      },
      spaceBefore: { type: "number", min: 0, max: 200, about: "Space before, in points." },
      spaceAfter: { type: "number", min: 0, max: 200, about: "Space after, in points." },
      lineSpacing: {
        type: "number",
        min: 0.5,
        max: 5,
        about: "Line spacing as a multiple, e.g. 1.15.",
      },
    },
    required: ["style"],
    change: ["restyled", "style"],
  },
  addFootnote: {
    about: "Add a footnote at the end of a paragraph.",
    fields: {
      block: { ...block, about: "The paragraph's block number." },
      text: { type: "text", about: "Footnote text." },
    },
    required: ["block", "text"],
    change: ["added", "footnote"],
  },
  setTitle: {
    about: "Set the document's title property (shown by Word in File > Info, not in the text).",
    fields: { title: { type: "string", max: 300, about: "Title." } },
    required: ["title"],
    change: ["set", "title"],
  },
  setPageLayout: {
    about:
      "Set page settings for the document's last section (the whole document unless it has section breaks). Give only what changes.",
    fields: {
      size: { type: "string", max: 6, options: ["A4", "Letter"], about: "Paper size." },
      orientation: {
        type: "string",
        max: 9,
        options: ["portrait", "landscape"],
        about: "Orientation.",
      },
      margins: {
        type: "string",
        max: 8,
        options: ["normal", "narrow", "moderate", "wide"],
        about: "Word's margin presets: normal 2.54 cm, narrow 1.27 cm, moderate, wide.",
      },
      firstPageDifferent: {
        type: "boolean",
        about: "Leave the first page (a cover) out of the header and footer.",
      },
    },
    required: [],
    change: ["changed", "page layout"],
  },
} as const satisfies Record<string, Definition>;

type Catalog = typeof WORD_OPERATIONS;
export type WordOperationKind = keyof Catalog;
export type ParagraphStyle = (typeof PARAGRAPH_STYLES)[number];

type ValueOf<F> = F extends { type: "integer" | "number" }
  ? number
  : F extends { type: "boolean" }
    ? boolean
    : F extends { type: "grid" }
      ? string[][]
      : F extends { type: "list"; of: infer I }
        ? ValueOf<I>[]
        : F extends { type: "object"; fields: infer Fs; required: readonly (infer R)[] }
          ? Shape<Fs, R>
          : F extends { type: "string"; options: readonly (infer O)[] }
            ? O
            : string;
type Shape<Fs, R> = { -readonly [K in keyof Fs & R]: ValueOf<Fs[K]> } & {
  -readonly [K in Exclude<keyof Fs, R>]?: ValueOf<Fs[K]>;
};
export type WordOperation = {
  [K in WordOperationKind]: { kind: K } & Shape<
    Catalog[K]["fields"],
    Catalog[K]["required"][number]
  >;
}[WordOperationKind];
export type NewParagraph = Extract<
  WordOperation,
  { kind: "insertParagraphs" }
>["paragraphs"][number];

const describe = (field: OwnField) => {
  switch (field.type) {
    case "text":
      return `text up to ${WORD_LIMITS.paragraphChars} characters`;
    case "grid":
      return "a list of rows, each a list of cell texts";
    case "image":
      return "an image reference such as attachment:<id>";
    case "style":
      return "a style name";
    case "color":
      return "a #RRGGBB colour";
  }
};

/**
 * `tool` checks what the model sent; `worker` checks the same batch after the
 * tool swapped each picture reference for the authorized bytes.
 */
type Stage = "tool" | "worker";

function value(
  field: OwnField,
  raw: unknown,
  path: string,
  stage: Stage,
  wrong: () => never,
): unknown {
  switch (field.type) {
    case "text":
      if (typeof raw === "number") return String(raw);
      if (typeof raw !== "string" || raw.length > WORD_LIMITS.paragraphChars) return wrong();
      return xmlSafe(raw)
        ? raw.replaceAll("\r\n", "\n")
        : engine.fail(path, "text contains control characters");
    case "style": {
      if (typeof raw !== "string" || !raw.trim() || raw.length > 100 || !xmlSafe(raw))
        return wrong();
      // "Heading 2", "heading2" and "HEADING2" all mean the built-in style.
      const key = raw.toLowerCase().replaceAll(/\s+/g, "");
      return (PARAGRAPH_STYLES as readonly string[]).includes(key) ? key : raw.trim();
    }
    case "color":
      return typeof raw === "string" && /^#?[0-9a-f]{6}$/i.test(raw)
        ? raw.replace(/^#/, "").toUpperCase()
        : wrong();
    case "image":
      if (stage === "worker") return raw instanceof Uint8Array ? raw : wrong();
      return typeof raw === "string" && /^(?:attachment|project|skill|working):\S{1,400}$/.test(raw)
        ? raw
        : wrong();
    case "grid": {
      if (!Array.isArray(raw) || raw.length === 0) return wrong();
      // One row given flat is the common near miss.
      const rows = raw.every((row) => !Array.isArray(row)) ? [raw] : raw;
      const cell = { type: "text", about: "" } as const;
      const grid = rows.map((row, index) =>
        Array.isArray(row) && row.length > 0 && row.length <= 64
          ? row.map((item, column) => {
              const at = `${path}[${index}][${column}]`;
              return item === null
                ? ""
                : (value(cell, item, at, stage, () =>
                    engine.fail(at, `expected ${describe(cell)}; received ${received(item)}`),
                  ) as string);
            })
          : engine.fail(
              `${path}[${index}]`,
              `expected a row of 1–64 cells; received ${received(row)}`,
            ),
      );
      if (grid.some((row) => row.length !== grid[0]!.length))
        engine.fail(path, "every row needs the same number of cells");
      return grid;
    }
  }
}

const engine = operationEngine<OwnField, Stage>({
  operations: WORD_OPERATIONS,
  maxOperations: WORD_LIMITS.operationsPerCall,
  Error: WordError,
  own: {
    describe,
    value,
    schema: (field) => {
      switch (field.type) {
        case "text":
          return {
            type: "string",
            maxLength: WORD_LIMITS.paragraphChars,
            description: field.about,
          };
        case "image":
          return { type: "string", maxLength: 420, description: field.about };
        case "style":
          return { type: "string", maxLength: 100, description: field.about };
        case "color":
          return { type: "string", pattern: "^#?[0-9A-Fa-f]{6}$", description: field.about };
        case "grid":
          return {
            type: "array",
            description: field.about,
            items: { type: "array", items: { type: "string" } },
          };
      }
    },
  },
});

const textOf = (operation: Record<string, unknown>): number => {
  let total = 0;
  const walk = (item: unknown) => {
    if (typeof item === "string") total += item.length;
    else if (Array.isArray(item)) item.forEach(walk);
    else if (item && typeof item === "object" && !(item instanceof Uint8Array))
      Object.values(item).forEach(walk);
  };
  walk(operation);
  return total;
};

export function parseWordOperations(input: unknown, at: Stage = "tool"): WordOperation[] {
  let chars = 0;
  let cells = 0;
  const operations = engine.parse(input, at, (kind, operation, path) => {
    const fail = (message: string, field = path) => engine.fail(field, message);
    if ("before" in WORD_OPERATIONS[kind as WordOperationKind].fields) {
      const given = ["before", "after", "at"].filter((key) => key in operation);
      if (given.length !== 1) fail("give exactly one of before, after or at");
    }
    if (kind === "setParagraph" && Object.keys(operation).length === 1)
      fail("provide text, style or align to change");
    if (
      (kind === "setPageLayout" && Object.keys(operation).length === 0) ||
      (kind === "setStyle" && Object.keys(operation).length === 1)
    )
      fail("provide at least one property to change");
    if (
      kind === "setPageNumbers" &&
      operation.text !== undefined &&
      !String(operation.text).includes("{page}")
    )
      fail('include {page} where the number goes, e.g. "Page {page}"', `${path}.text`);
    if (kind === "replaceText" && (operation.replace as string).includes("\n"))
      fail("a replacement stays within one paragraph; use no newlines", `${path}.replace`);
    if (kind === "insertTable" || kind === "addTableRows")
      cells += (operation.rows as string[][]).reduce((sum, row) => sum + row.length, 0);
    chars += textOf(operation);
  });
  if (chars > WORD_LIMITS.charsPerCall)
    engine.fail(
      "operations",
      `at most ${WORD_LIMITS.charsPerCall} characters of text per call; received ${chars}. Split into smaller calls; no edits were applied`,
    );
  if (cells > WORD_LIMITS.tableCellsPerCall)
    engine.fail(
      "operations",
      `at most ${WORD_LIMITS.tableCellsPerCall} table cells per call; received ${cells}. Split into smaller calls; no edits were applied`,
    );
  // The table's fields were each checked above; the type is the table's.
  return operations as WordOperation[];
}

/** The operations parameter as the model sees it: one branch per kind. */
export const wordOperationsJsonSchema = engine.jsonSchema;

/** "Inserted 2 paragraph groups and a table", from operation kinds alone, for people. */
export const describeWordChanges: (operations: readonly WordOperation[]) => string =
  engine.describeChanges;
