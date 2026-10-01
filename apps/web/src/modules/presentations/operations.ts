import {
  operationEngine,
  xmlSafe,
  type Definition as OfficeDefinition,
} from "../office/operations.ts";
import { PRESENTATION_LIMITS } from "./limits.ts";
import { PresentationError } from "./errors.ts";

/**
 * The one description of every presentation edit. Validation, the JSON schema
 * the model is offered, the adapter's operation types and the activity's change
 * summary are all derived from this table, so they cannot drift apart.
 */
type OwnField =
  | { readonly type: "text"; readonly about: string }
  | {
      readonly type: "color";
      readonly about: string;
      readonly none?: boolean;
      /** Only #RRGGBB, for places that define theme colours rather than use them. */
      readonly hexOnly?: boolean;
    }
  | { readonly type: "ref"; readonly about: string }
  | { readonly type: "image"; readonly about: string };
type Definition = OfficeDefinition<OwnField>;

const slideId = {
  type: "integer",
  min: 1,
  max: 0xffffffff,
  about: "Slide ID from slides[].slideId.",
} as const;
const slideRef = {
  type: "ref",
  about:
    'Ref given to a slide created earlier in this batch, or "first" for the deck\'s first slide (on a new deck, its Title Slide).',
} as const;
const shapeId = {
  type: "integer",
  min: 1,
  max: 0xffffffff,
  about: "Shape ID from shapes[].shapeId on this slide.",
} as const;
const shapeRef = {
  type: "ref",
  about: "Ref given to a shape created earlier in this batch.",
} as const;
const placeholder = {
  type: "string",
  max: 10,
  pattern: "^(title|subtitle|body|body([2-9]|[1-9][0-9]+))$",
  about:
    "A canonical placeholder from inspection, instead of shapeId: title, subtitle, body or bodyN (decimal N >= 2, at most 10 characters). Ambiguous placeholders require an exact slide shapeId.",
} as const;
const ref = {
  type: "ref",
  about:
    "Name for the created object, usable as slideRef/shapeRef by later operations in this batch.",
} as const;
const point = (about: string) => ({ type: "number", min: 0, max: 2000, about }) as const;
const extent = (about: string) => ({ type: "number", min: 1, max: 2000, about }) as const;
const box = {
  x: point("Left edge in points (a 16:9 slide is 960 × 540)."),
  y: point("Top edge in points."),
  width: extent("Width in points."),
  height: extent("Height in points."),
} as const;
const format = {
  fontSize: { type: "number", min: 1, max: 400, about: "Font size in points." },
  bold: { type: "boolean", about: "Bold text." },
  italic: { type: "boolean", about: "Italic text." },
  underline: { type: "boolean", about: "Underlined text." },
  color: { type: "color", about: "Text colour; a theme colour keeps the deck\u2019s palette." },
  font: {
    type: "string",
    max: 100,
    about: "Typeface: one of availableFonts from the latest result. Omitted keeps the theme font.",
  },
} as const;
const align = {
  type: "string",
  max: 7,
  options: ["left", "center", "right", "justify"],
  about: "Horizontal alignment.",
} as const;
const text = { type: "text", about: "Text. A newline starts a new paragraph." } as const;
const paragraphs = {
  type: "list",
  min: 1,
  max: 100,
  about: "Structured paragraphs, for bullets, indent levels or mixed formatting in one paragraph.",
  of: {
    type: "object",
    about: "One paragraph: text or runs.",
    required: [],
    exclusive: [["text", "runs"]],
    fields: {
      text: { type: "text", about: "Paragraph text." },
      runs: {
        type: "list",
        min: 1,
        max: 50,
        about: "Differently formatted pieces of one paragraph.",
        of: {
          type: "object",
          about: "A run of text with its own format.",
          required: ["text"],
          fields: { text: { type: "text", about: "Run text." }, ...format },
        },
      },
      level: { type: "integer", min: 0, max: 8, about: "Indent level; 0 is the outermost bullet." },
      bullet: {
        type: "string",
        max: 6,
        options: ["bullet", "number", "none"],
        about: "Bullet style; omitted keeps the placeholder's own style.",
      },
      align,
      ...format,
    },
  },
} as const;
const target = { slideId, slideRef, shapeId, shapeRef, placeholder } as const;
const templateId = {
  type: "string",
  max: 160,
  about:
    "Edit a template instead of a slide: a layoutId from layouts[] or a masterId from masters[]. Every slide using it changes. Inspect with templateId to list its shapes.",
} as const;
const targetGroups = [
  ["slideId", "slideRef"],
  ["shapeId", "shapeRef", "placeholder"],
] as const;
const slideGroup = [["slideId", "slideRef"]] as const;
const chartContent = {
  chartType: {
    type: "string",
    max: 8,
    options: ["column", "bar", "line", "area", "pie", "doughnut"],
    about: "Chart type. pie and doughnut take exactly one series.",
  },
  title: { type: "text", about: "Chart title." },
  categories: {
    type: "list",
    min: 1,
    max: 100,
    about: "Category labels along the axis, or slice labels.",
    of: { type: "string", max: 200, about: "Category label." },
  },
  series: {
    type: "list",
    min: 1,
    max: 12,
    about: "Data series; each has one value per category.",
    of: {
      type: "object",
      about: "One series.",
      required: ["name", "values"],
      fields: {
        name: { type: "string", max: 200, about: "Series name shown in the legend." },
        values: {
          type: "list",
          min: 1,
          max: 100,
          about: "One number per category.",
          of: { type: "number", min: -1e15, max: 1e15, about: "Value." },
        },
        color: {
          type: "color",
          about: "Series colour; theme colours keep the deck\u2019s palette.",
        },
      },
    },
  },
  stacking: {
    type: "string",
    max: 8,
    options: ["none", "stacked", "percent"],
    about: "Stack column, bar, line or area series.",
  },
  legend: {
    type: "string",
    max: 6,
    options: ["right", "top", "bottom", "left", "none"],
    about: "Legend position.",
  },
  dataLabels: { type: "boolean", about: "Show values on the chart." },
  numberFormat: {
    type: "string",
    max: 30,
    about: 'Excel-style format for values on the axis and labels, e.g. "0%", "#,##0", "$#,##0.0".',
  },
  valueAxisTitle: { type: "text", about: "Title beside the value axis." },
  categoryAxisTitle: { type: "text", about: "Title under the category axis." },
  valueAxisMin: { type: "number", min: -1e15, max: 1e15, about: "Lowest value on the value axis." },
  valueAxisMax: {
    type: "number",
    min: -1e15,
    max: 1e15,
    about: "Highest value on the value axis.",
  },
  gridlines: { type: "boolean", about: "Show horizontal gridlines (default on)." },
  gapWidth: {
    type: "integer",
    min: 0,
    max: 500,
    about: "Space between column or bar groups as a percent of a bar's width; lower is chunkier.",
  },
  textColor: { type: "color", about: "Colour of the title, labels and legend." },
  textFont: {
    type: "string",
    max: 100,
    about: "Typeface for the chart's text: one of availableFonts.",
  },
  textSize: {
    type: "number",
    min: 6,
    max: 72,
    about: "Size of axis labels and legend in points; the title is larger.",
  },
} as const;
const alignOption = {
  type: "string",
  max: 6,
  options: ["left", "center", "right"],
  about: "Horizontal alignment.",
} as const;
const verticalAlign = {
  type: "string",
  max: 6,
  options: ["top", "center", "bottom"],
  about: "Vertical alignment in the cell.",
} as const;
/** How a whole table looks; explicit colours render the same in previews and PowerPoint. */
const tableStyle = {
  headerFill: { type: "color", about: "First row background, e.g. accent1." },
  headerColor: { type: "color", about: "First row text colour, e.g. light1." },
  headerBold: { type: "boolean", about: "Bold first row text." },
  bodyFill: { type: "color", none: true, about: "Background of the other rows, or none." },
  bandFill: {
    type: "color",
    about: "Background of every second row after the header, for banding.",
  },
  textColor: { type: "color", about: "Text colour of the other rows." },
  font: {
    type: "string",
    max: 100,
    about: "Typeface for every cell: one of availableFonts.",
  },
  fontSize: { type: "number", min: 1, max: 400, about: "Font size for every cell." },
  borderColor: { type: "color", none: true, about: "Colour of all cell borders, or none." },
  borderWidth: { type: "number", min: 0.25, max: 12, about: "Border width in points." },
  columnWidths: {
    type: "list",
    min: 1,
    max: PRESENTATION_LIMITS.tableColumns,
    about: "Width of each column in points, one per column.",
    of: { type: "number", min: 5, max: 2000, about: "Column width." },
  },
  rowHeight: { type: "number", min: 5, max: 500, about: "Minimum height of every row in points." },
  columnAlign: {
    type: "list",
    min: 1,
    max: PRESENTATION_LIMITS.tableColumns,
    about: 'Alignment of each column, one per column, e.g. ["left", "right"] for numbers.',
    of: alignOption,
  },
  verticalAlign,
} as const;
const themeColor = (about: string) => ({ type: "color", hexOnly: true, about }) as const;
const font = {
  type: "string",
  max: 100,
  about: "Typeface: one of availableFonts from the latest result.",
} as const;

export const PRESENTATION_OPERATIONS = {
  addSlide: {
    about:
      "Add a slide from a layout. Fill its placeholders with setText (placeholder: title/body).",
    fields: {
      layoutId: {
        type: "string",
        max: 160,
        about: "layouts[].layoutId, or an exact layout name such as Title and Content.",
      },
      index: { type: "integer", min: 0, max: 99, about: "Zero-based position; omitted appends." },
      ref,
    },
    required: ["layoutId"],
    change: ["added", "slide"],
  },
  duplicateSlide: {
    about: "Copy a slide, placing the copy after it unless index is given.",
    fields: {
      slideId,
      slideRef,
      index: { type: "integer", min: 0, max: 99, about: "Zero-based position." },
      ref,
    },
    required: [],
    exclusive: slideGroup,
    change: ["duplicated", "slide"],
  },
  moveSlide: {
    about: "Move a slide to a zero-based position.",
    fields: {
      slideId,
      slideRef,
      index: { type: "integer", min: 0, max: 99, about: "Zero-based position." },
    },
    required: ["index"],
    exclusive: slideGroup,
    change: ["reordered the slides"],
  },
  removeSlide: {
    about: "Delete a slide. The last slide cannot be removed.",
    fields: { slideId, slideRef },
    required: [],
    exclusive: slideGroup,
    change: ["removed", "slide"],
  },
  setSlideLayout: {
    about:
      "Rebind a slide to another layout in this deck, preserving all its existing shapes and text. Does not instantiate missing placeholders or clear old content. To build a fresh slide from a layout, use addSlide instead.",
    fields: {
      slideId,
      slideRef,
      layoutId: { type: "string", max: 160, about: "layouts[].layoutId or exact layout name." },
    },
    required: ["layoutId"],
    exclusive: slideGroup,
    change: ["changed a slide layout"],
  },
  setNotes: {
    about: "Replace a slide's speaker notes. An empty string clears them.",
    fields: { slideId, slideRef, text: { type: "text", about: "Speaker notes." } },
    required: ["text"],
    exclusive: slideGroup,
    change: ["wrote speaker notes"],
  },
  setBackground: {
    about: "Give a slide, layout or master a solid background colour.",
    fields: {
      slideId,
      slideRef,
      templateId,
      color: { type: "color", about: "Background colour." },
    },
    required: ["color"],
    exclusive: [["slideId", "slideRef", "templateId"]],
    change: ["changed a background"],
  },
  setText: {
    about:
      "Replace all text in a text shape or placeholder. Keeps the placeholder's or shape's own styling unless format fields are given.",
    fields: { ...target, text, paragraphs, ...format, align },
    required: [],
    exclusive: [...targetGroups, ["text", "paragraphs"]],
    change: ["wrote the text"],
  },
  formatText: {
    about: "Change formatting of existing text, for the whole shape or one paragraph.",
    fields: {
      ...target,
      paragraph: {
        type: "integer",
        min: 0,
        max: 999,
        about: "Zero-based paragraph; omitted formats all text.",
      },
      ...format,
      align,
    },
    required: [],
    exclusive: targetGroups,
    change: ["styled the text"],
  },
  replaceAll: {
    about:
      "Find and replace literal text within runs, on one slide or every slide. Keeps formatting.",
    fields: {
      slideId,
      slideRef,
      find: { type: "string", max: 500, about: "Exact text to find." },
      replace: { type: "text", about: "Replacement text." },
      scope: {
        type: "string",
        max: 10,
        options: ["slides", "everywhere"],
        about:
          "everywhere also changes layouts and masters, such as footer wording (default slides).",
      },
    },
    required: ["find", "replace"],
    change: ["replaced some wording"],
  },
  addText: {
    about: "Add a text box.",
    fields: { slideId, slideRef, ...box, text, paragraphs, ...format, align, ref },
    required: ["x", "y", "width", "height"],
    exclusive: [...slideGroup, ["text", "paragraphs"]],
    change: ["added text"],
  },
  addShape: {
    about: "Add a filled shape, optionally with text.",
    fields: {
      slideId,
      slideRef,
      shape: {
        type: "string",
        max: 16,
        options: [
          "rect",
          "roundRect",
          "ellipse",
          "triangle",
          "diamond",
          "hexagon",
          "chevron",
          "rightArrow",
          "leftArrow",
          "star5",
          "plus",
        ],
        about: "Shape preset.",
      },
      ...box,
      fill: { type: "color", none: true, about: "Fill colour, or none." },
      line: { type: "color", none: true, about: "Outline colour, or none." },
      lineWidth: { type: "number", min: 0.25, max: 50, about: "Outline width in points." },
      text,
      ...format,
      align,
      ref,
    },
    required: ["shape", "x", "y", "width", "height"],
    exclusive: slideGroup,
    change: ["added", "shape"],
  },
  addLine: {
    about: "Add a straight line between two points.",
    fields: {
      slideId,
      slideRef,
      x1: point("Start x in points."),
      y1: point("Start y in points."),
      x2: point("End x in points."),
      y2: point("End y in points."),
      color: { type: "color", about: "Line colour." },
      lineWidth: { type: "number", min: 0.25, max: 50, about: "Width in points." },
      ref,
    },
    required: ["x1", "y1", "x2", "y2"],
    exclusive: slideGroup,
    change: ["added", "line"],
  },
  styleShape: {
    about: "Change a shape's fill or outline.",
    fields: {
      ...target,
      fill: { type: "color", none: true, about: "Fill colour, or none." },
      line: { type: "color", none: true, about: "Outline colour, or none." },
      lineWidth: { type: "number", min: 0.25, max: 50, about: "Outline width in points." },
    },
    required: [],
    exclusive: targetGroups,
    change: ["restyled some shapes"],
  },
  setBounds: {
    about: "Move or resize a shape. Omitted edges keep their current value.",
    fields: {
      ...target,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
    },
    required: [],
    exclusive: targetGroups,
    change: ["adjusted the layout"],
  },
  arrangeShape: {
    about: "Bring a shape to the front or send it to the back.",
    fields: {
      ...target,
      order: { type: "string", max: 5, options: ["front", "back"], about: "Stacking order." },
    },
    required: ["order"],
    exclusive: targetGroups,
    change: ["adjusted the layout"],
  },
  removeShape: {
    about:
      "Delete a shape, picture, table, chart or placeholder from a slide, or a shape (e.g. an old logo) from a layout or master.",
    fields: { ...target, templateId },
    required: [],
    exclusive: [
      ["slideId", "slideRef", "templateId"],
      ["shapeId", "shapeRef", "placeholder"],
    ],
    change: ["removed some content"],
  },
  ungroup: {
    about:
      "Split a group into its shapes so each can be moved or removed on its own. Shapes inside a group already accept text and style edits.",
    fields: { slideId, slideRef, shapeId, shapeRef },
    required: [],
    exclusive: [...slideGroup, ["shapeId", "shapeRef"]],
    change: ["ungrouped some shapes"],
  },
  addImage: {
    about: "Add a PNG or JPEG from an authorized attachment or project file.",
    fields: {
      slideId,
      slideRef,
      imageRef: {
        type: "image",
        about:
          "A picture: attachment:<id>, project:<id>@<version>, a skill image's skill: reference, or the working: reference import_local_file returned.",
      },
      imageFingerprint: { type: "string", max: 64, about: "Optional SHA-256 pin of the image." },
      ...box,
      fit: {
        type: "string",
        max: 7,
        options: ["contain", "fill"],
        about: "contain keeps the aspect ratio (default); fill stretches.",
      },
      ref,
    },
    required: ["imageRef", "x", "y", "width", "height"],
    exclusive: slideGroup,
    change: ["added", "picture"],
  },
  replaceImage: {
    about:
      "Swap a picture's image in place, keeping its position, crop and effects; on a layout or master this changes e.g. the logo on every slide.",
    fields: {
      slideId,
      slideRef,
      templateId,
      shapeId,
      shapeRef,
      imageRef: {
        type: "image",
        about:
          "A picture: attachment:<id>, project:<id>@<version>, a skill image's skill: reference, or the working: reference import_local_file returned.",
      },
      imageFingerprint: { type: "string", max: 64, about: "Optional SHA-256 pin of the image." },
    },
    required: ["imageRef"],
    exclusive: [
      ["slideId", "slideRef", "templateId"],
      ["shapeId", "shapeRef"],
    ],
    change: ["replaced", "picture"],
  },
  addTable: {
    about:
      "Add a table. Without style fields it gets the default accent header and banding; give headerFill, bandFill, borderColor and the like (theme colours keep the deck's look) to match the design.",
    fields: {
      slideId,
      slideRef,
      ...box,
      rows: {
        type: "list",
        min: 1,
        max: PRESENTATION_LIMITS.tableRows,
        about: `Rows of cell text; every row has the same number of cells (1 to ${PRESENTATION_LIMITS.tableColumns}).`,
        of: {
          type: "list",
          min: 1,
          max: PRESENTATION_LIMITS.tableColumns,
          about: "One row.",
          of: { type: "string", max: 2000, about: "Cell text." },
        },
      },
      header: { type: "boolean", about: "Style the first row as a header (default true)." },
      banded: { type: "boolean", about: "Alternate row shading (default true)." },
      ...tableStyle,
      ref,
    },
    required: ["x", "y", "width", "height", "rows"],
    exclusive: slideGroup,
    change: ["added", "table"],
  },
  setTableCells: {
    about: "Change text or formatting of table cells. Rows and columns are zero-based.",
    fields: {
      slideId,
      slideRef,
      shapeId,
      shapeRef,
      cells: {
        type: "list",
        min: 1,
        max: 400,
        about: "Cells to change.",
        of: {
          type: "object",
          about: "One cell.",
          required: ["row", "column"],
          fields: {
            row: { type: "integer", min: 0, max: 99, about: "Zero-based row." },
            column: { type: "integer", min: 0, max: 99, about: "Zero-based column." },
            text: { type: "string", max: 2000, about: "Cell text." },
            fill: { type: "color", about: "Cell background colour." },
            align: alignOption,
            verticalAlign,
            ...format,
          },
        },
      },
    },
    required: ["cells"],
    exclusive: [...slideGroup, ["shapeId", "shapeRef"]],
    change: ["updated a table"],
  },
  styleTable: {
    about: "Restyle a whole table: header, banding, borders, fonts, column widths and alignment.",
    fields: { slideId, slideRef, shapeId, shapeRef, ...tableStyle },
    required: [],
    exclusive: [...slideGroup, ["shapeId", "shapeRef"]],
    change: ["styled a table"],
  },
  mergeTableCells: {
    about: "Merge a block of cells into one, keeping the top-left cell's text.",
    fields: {
      slideId,
      slideRef,
      shapeId,
      shapeRef,
      row: { type: "integer", min: 0, max: 99, about: "Zero-based top row." },
      column: { type: "integer", min: 0, max: 99, about: "Zero-based left column." },
      rowSpan: {
        type: "integer",
        min: 1,
        max: PRESENTATION_LIMITS.tableRows,
        about: "Rows to merge.",
      },
      columnSpan: {
        type: "integer",
        min: 1,
        max: PRESENTATION_LIMITS.tableColumns,
        about: "Columns to merge.",
      },
    },
    required: ["row", "column", "rowSpan", "columnSpan"],
    exclusive: [...slideGroup, ["shapeId", "shapeRef"]],
    change: ["updated a table"],
  },
  addTableRow: {
    about: "Insert a table row, copying the formatting of its neighbour.",
    fields: {
      slideId,
      slideRef,
      shapeId,
      shapeRef,
      index: { type: "integer", min: 0, max: 99, about: "Zero-based position; omitted appends." },
      cells: {
        type: "list",
        min: 1,
        max: PRESENTATION_LIMITS.tableColumns,
        about: "Text for the new row's cells.",
        of: { type: "string", max: 2000, about: "Cell text." },
      },
    },
    required: [],
    exclusive: [...slideGroup, ["shapeId", "shapeRef"]],
    change: ["updated a table"],
  },
  removeTableRow: {
    about: "Delete a table row.",
    fields: {
      slideId,
      slideRef,
      shapeId,
      shapeRef,
      index: { type: "integer", min: 0, max: 99, about: "Zero-based row." },
    },
    required: ["index"],
    exclusive: [...slideGroup, ["shapeId", "shapeRef"]],
    change: ["updated a table"],
  },
  addTableColumn: {
    about: "Insert a table column.",
    fields: {
      slideId,
      slideRef,
      shapeId,
      shapeRef,
      index: { type: "integer", min: 0, max: 99, about: "Zero-based position; omitted appends." },
    },
    required: [],
    exclusive: [...slideGroup, ["shapeId", "shapeRef"]],
    change: ["updated a table"],
  },
  removeTableColumn: {
    about: "Delete a table column.",
    fields: {
      slideId,
      slideRef,
      shapeId,
      shapeRef,
      index: { type: "integer", min: 0, max: 99, about: "Zero-based column." },
    },
    required: ["index"],
    exclusive: [...slideGroup, ["shapeId", "shapeRef"]],
    change: ["updated a table"],
  },
  addChart: {
    about: "Add an editable chart. Its data is embedded, so it opens in PowerPoint's Edit Data.",
    fields: { slideId, slideRef, ...box, ...chartContent, ref },
    required: ["x", "y", "width", "height", "chartType", "categories", "series"],
    exclusive: slideGroup,
    change: ["added", "chart"],
  },
  updateChart: {
    about: "Replace a chart's data. Omitted chartType, title and legend keep their current values.",
    fields: { slideId, slideRef, shapeId, shapeRef, ...chartContent },
    required: ["categories", "series"],
    exclusive: [...slideGroup, ["shapeId", "shapeRef"]],
    change: ["updated a chart"],
  },
  setTheme: {
    about: "Change the deck's theme colours and fonts. Affects every slide that uses them.",
    fields: {
      dark1: themeColor("Main text colour."),
      light1: themeColor("Main background colour."),
      dark2: themeColor("Secondary dark colour."),
      light2: themeColor("Secondary light colour."),
      accent1: themeColor("Accent 1, the main highlight and first chart series."),
      accent2: themeColor("Accent 2."),
      accent3: themeColor("Accent 3."),
      accent4: themeColor("Accent 4."),
      accent5: themeColor("Accent 5."),
      accent6: themeColor("Accent 6."),
      headingFont: font,
      bodyFont: font,
    },
    required: [],
    change: ["changed the theme"],
  },
} as const satisfies Record<string, Definition>;

type Catalog = typeof PRESENTATION_OPERATIONS;
export type PresentationOperationKind = keyof Catalog;

/** Theme slots a colour may name so it follows the deck's own palette. */
export const THEME_COLORS = [
  "dark1",
  "light1",
  "dark2",
  "light2",
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
] as const;
export type ThemeColor = (typeof THEME_COLORS)[number];
export type PresentationColor = `#${string}` | ThemeColor;

type ValueOf<F> = F extends { type: "integer" | "number" }
  ? number
  : F extends { type: "color"; hexOnly: true }
    ? `#${string}`
    : F extends { type: "color"; none: true }
      ? PresentationColor | "none"
      : F extends { type: "color" }
        ? PresentationColor
        : F extends { type: "boolean" }
          ? boolean
          : F extends { type: "image" }
            ? Uint8Array
            : F extends { type: "list"; of: infer I }
              ? ValueOf<I>[]
              : F extends { type: "object"; fields: infer Fs; required: readonly (infer R)[] }
                ? Shape<Fs, R>
                : string;
type Shape<Fs, R> = { -readonly [K in keyof Fs & R]: ValueOf<Fs[K]> } & {
  -readonly [K in Exclude<keyof Fs, R>]?: ValueOf<Fs[K]>;
};
export type PresentationOperation = {
  [K in PresentationOperationKind]: { kind: K } & Shape<
    Catalog[K]["fields"],
    Catalog[K]["required"][number]
  >;
}[PresentationOperationKind];

const describe = (field: OwnField) => {
  switch (field.type) {
    case "text":
      return "text";
    case "color":
      return field.hexOnly
        ? "a #RRGGBB colour"
        : `a #RRGGBB colour or theme colour (${THEME_COLORS.join(", ")})${field.none ? ' or "none"' : ""}`;
    case "ref":
      return "a ref name (letters, digits, - or _)";
    case "image":
      return "an attachment:<id>, project:<id>@<version>, skill:<revision>/<path> or working:<id>@<revision> reference";
  }
};

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
      if (typeof raw !== "string" || raw.length > PRESENTATION_LIMITS.textChars || !xmlSafe(raw))
        return wrong();
      return raw;
    case "color": {
      if (field.none && raw === "none") return raw;
      if (
        !field.hexOnly &&
        typeof raw === "string" &&
        (THEME_COLORS as readonly string[]).includes(raw)
      )
        return raw;
      if (typeof raw !== "string" || !/^#?[0-9a-f]{6}$/i.test(raw)) return wrong();
      return `#${raw.replace(/^#/, "").toUpperCase()}`;
    }
    case "ref":
      return typeof raw === "string" && /^[A-Za-z][\w-]{0,39}$/.test(raw) ? raw : wrong();
    case "image":
      if (stage === "worker") {
        if (!(raw instanceof Uint8Array) || raw.length > PRESENTATION_LIMITS.imageBytes)
          return engine.fail(path, "an image must be a bounded PNG or JPEG byte array");
        return raw;
      }
      // A skill reference carries a path of up to 240 characters.
      return typeof raw === "string" && raw.length <= 300 ? raw : wrong();
  }
}

const engine = operationEngine<OwnField, Stage>({
  operations: PRESENTATION_OPERATIONS,
  maxOperations: PRESENTATION_LIMITS.operationsPerCall,
  Error: PresentationError,
  description:
    "Ordered edits applied atomically. Each item's kind picks its fields; exactly-one choices (slideId or slideRef; shapeId, shapeRef or placeholder; text or paragraphs) are named in field descriptions.",
  own: {
    describe,
    value,
    schema: (field) =>
      field.type === "color"
        ? {
            type: "string",
            pattern: field.hexOnly
              ? "^#[0-9A-Fa-f]{6}$"
              : `^(#[0-9A-Fa-f]{6}|${THEME_COLORS.join("|")}${field.none ? "|none" : ""})$`,
            description: field.about,
          }
        : { type: "string", description: field.about },
  },
});

/**
 * Validates a batch. The tool stage takes image references; by the worker
 * stage the parent has swapped each for authorized bytes under the same key.
 */
export function parsePresentationOperations(
  input: unknown,
  stage: Stage = "worker",
): PresentationOperation[] {
  // "first" is built in: the deck's first slide when the batch starts.
  const refs = new Set<string>(["first"]);
  const operations = engine.parse(input, stage, (kind, operation, path) => {
    for (const key of ["slideRef", "shapeRef"])
      if (typeof operation[key] === "string" && !refs.has(operation[key]))
        engine.fail(path, `${key} "${operation[key]}" was not created earlier in this batch`);
    if (typeof operation.ref === "string") {
      if (refs.has(operation.ref)) engine.fail(path, `ref "${operation.ref}" is already used`);
      refs.add(operation.ref);
    }
    if (kind === "addChart" || kind === "updateChart") chartSeriesFit(operation, path);
    if (kind === "addTable") tableRectangular(operation.rows as string[][], path);
    if (
      kind === "formatText" ||
      kind === "styleShape" ||
      kind === "setBounds" ||
      kind === "styleTable"
    )
      if (!Object.keys(operation).some((key) => !(key in target) && key !== "paragraph"))
        engine.fail(path, "provide at least one property to change");
  });
  // The table's fields were each checked above; the type is the table's.
  return operations as PresentationOperation[];
}

function chartSeriesFit(operation: Record<string, unknown>, path: string) {
  const categories = operation.categories as string[];
  const series = operation.series as { values: number[] }[];
  if ((operation.chartType === "pie" || operation.chartType === "doughnut") && series.length !== 1)
    engine.fail(path, `${operation.chartType} charts take exactly one series`);
  for (const [index, item] of series.entries())
    if (item.values.length !== categories.length)
      engine.fail(
        `${path}.series[${index}].values`,
        `expected ${categories.length} values, one per category; received ${item.values.length}`,
      );
}
function tableRectangular(rows: string[][], path: string) {
  const width = rows[0]!.length;
  for (const [index, row] of rows.entries())
    if (row.length !== width)
      engine.fail(
        `${path}.rows[${index}]`,
        `expected ${width} cells like the first row; received ${row.length}`,
      );
}

/** The operations parameter as the model sees it: one branch per kind. */
export const operationsJsonSchema = engine.jsonSchema;

/** "Added a slide and a chart and wrote the text", from operation kinds alone, for people. */
export const describePresentationChanges: (operations: readonly PresentationOperation[]) => string =
  engine.describeChanges;
