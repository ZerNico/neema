// The closed set of tags a block may use. One table drives both directions:
// the host validates every tree the runtime returns against it (unknown tags
// and props are dropped, never passed to React), and the skill's reference
// text is generated from it, so the model is told exactly what is accepted.

import { Option, Schema } from "effect";
import type { DiagnosticAction } from "./parse.ts";
import { stripHiddenText } from "./text.ts";

export const TREE_LIMITS = {
  nodes: 2000,
  depth: 40,
  stringChars: 64 * 1024,
  svgNodes: 1000,
  pathChars: 8 * 1024,
} as const;

interface PropSpec {
  readonly type: string;
  readonly required: boolean;
  readonly decode: (value: unknown) => Option.Option<unknown>;
}

function prop(schema: Schema.Codec<unknown, unknown>, type: string): PropSpec {
  const decode = Schema.decodeUnknownOption(schema);
  return { type, required: false, decode: (value) => decode(value) };
}

const required = (spec: PropSpec): PropSpec => ({ ...spec, required: true });

const text = (max = 500) => prop(Schema.String.check(Schema.isMaxLength(max)), "string");
const num = () => prop(Schema.Finite, "number");
const between = (minimum: number, maximum: number) =>
  prop(Schema.Finite.check(Schema.isBetween({ minimum, maximum })), `number ${minimum}–${maximum}`);
const int = (minimum: number, maximum: number) =>
  prop(Schema.Int.check(Schema.isBetween({ minimum, maximum })), `integer ${minimum}–${maximum}`);
const flag = () => prop(Schema.Boolean, "boolean");
const oneOf = <const L extends readonly [string, ...string[]]>(values: L) =>
  prop(Schema.Literals(values), values.map((v) => `"${v}"`).join(" | "));
const matching = (pattern: RegExp, type: string, max = 200) =>
  prop(Schema.String.check(Schema.isMaxLength(max), Schema.isPattern(pattern)), type);
const NUMBER_FORMAT_PATTERN =
  /^(?:decimal(?::\d{1,2})?|percent(?::\d{1,2})?|compact|currency:[A-Z]{3})$/;
const NUMBER_FORMAT_SCHEMA = Schema.String.check(
  Schema.isMaxLength(20),
  Schema.isPattern(NUMBER_FORMAT_PATTERN),
);
const FORMAT_LEGEND = '"decimal:2" | "percent" | "compact" | "currency:EUR"';
/** How <num>, tables and charts format numbers; ui/format.ts reads it. */
const NUMBER_FORMAT = prop(NUMBER_FORMAT_SCHEMA, "format");
/**
 * A value list used by several tags, printed once in the catalog's legend
 * and by name at each prop, so the reference does not repeat it.
 */
const named = <const L extends readonly [string, ...string[]]>(name: string, values: L) =>
  prop(Schema.Literals(values), name);
const handler = () =>
  prop(
    Schema.Struct({ $h: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), rev: Schema.Int }),
    "handler",
  );

const TONES = ["default", "muted", "primary", "success", "warning", "destructive"] as const;
const VARIANTS = ["default", "secondary", "outline", "ghost"] as const;
/** Map colours follow the chart palette, plus the meaning-bearing tones. */
const MAP_COLORS = [
  "primary",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "success",
  "warning",
  "destructive",
] as const;
const SVG_PAINT = [
  "none",
  "currentColor",
  "primary",
  "muted",
  "success",
  "warning",
  "destructive",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
] as const;
/** Names `<icon>` takes; ui/icons.ts maps each to a Hugeicons glyph. */
export const ICON_NAMES = [
  "check",
  "close",
  "plus",
  "minus",
  "arrow-right",
  "arrow-up",
  "arrow-down",
  "trend-up",
  "trend-down",
  "warning",
  "info",
  "idea",
  "star",
  "heart",
  "thumbs-up",
  "thumbs-down",
  "trophy",
  "target",
  "flag",
  "gift",
  "clock",
  "timer",
  "calendar",
  "pin",
  "globe",
  "home",
  "car",
  "bike",
  "walk",
  "run",
  "plane",
  "train",
  "bed",
  "person",
  "people",
  "money",
  "cart",
  "food",
  "coffee",
  "sun",
  "moon",
  "cloud",
  "rain",
  "snow",
  "fire",
  "water",
  "leaf",
  "tree",
  "book",
  "work",
  "medicine",
  "dumbbell",
  "music",
  "camera",
  "phone",
  "mail",
] as const;
/** A calendar day; read as that day wherever the reader is, never as an instant. */
const DAY = matching(/^\d{4}-\d{2}-\d{2}$/, '"YYYY-MM-DD"', 10);
const SPACE = () => int(0, 12);
const option = Schema.Union([
  Schema.String.check(Schema.isMaxLength(200)),
  Schema.Struct({
    label: Schema.String.check(Schema.isMaxLength(200)),
    value: Schema.String.check(Schema.isMaxLength(200)),
  }),
]);
const cell = Schema.Union([
  Schema.String.check(Schema.isMaxLength(2000)),
  Schema.Finite,
  Schema.Null,
]);

/** Where a tag may appear and what it may contain. */
type Children =
  | "none"
  | "plain"
  | "inline"
  | "block"
  | "svg"
  | { readonly only: readonly string[] };

export type TagGroup = "layout" | "text" | "input" | "data" | "media" | "map" | "chat" | "svg";

interface TagSpec {
  readonly group: TagGroup;
  readonly doc: string;
  readonly props: Readonly<Record<string, PropSpec>>;
  readonly children: Children;
}

const INLINE_TAGS = new Set(["b", "i", "code", "link", "num", "date", "badge", "math", "icon"]);

const SVG_SHAPE = {
  fill: named("paint", SVG_PAINT),
  stroke: named("paint", SVG_PAINT),
  strokeWidth: between(0, 100),
  opacity: between(0, 1),
  fillOpacity: between(0, 1),
  strokeOpacity: between(0, 1),
  transform: matching(
    /^\s*(?:(?:translate|rotate|scale)\(\s*-?\d+(?:\.\d+)?(?:\s*[ ,]\s*-?\d+(?:\.\d+)?){0,2}\s*\)\s*)+$/,
    "translate()/rotate()/scale()",
  ),
  // A tappable part of a drawing. It changes state only: sending, opening and
  // copying stay with real buttons, whose text the reader can see.
  onclick: handler(),
  label: text(120),
};
/** Names an element for `reveal(anchor)`, which scrolls it into view within the block. */
const ANCHOR = text(80);
/** One emoji, a pin's mark on the map: a flag, or a pictograph with its modifiers and joins. */
const EMOJI = matching(
  /^(?:\p{Regional_Indicator}{2}|\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?){0,4})$/u,
  "one emoji",
  32,
);
const POINTS = matching(/^[\d\s,.eE+-]*$/, "points", TREE_LIMITS.pathChars);

export const CATALOG: Readonly<Record<string, TagSpec>> = {
  box: {
    group: "layout",
    doc: "Vertical stack.",
    props: {
      gap: SPACE(),
      padding: SPACE(),
      align: oneOf(["start", "center", "end", "stretch"]),
      border: flag(),
      surface: flag(),
      anchor: ANCHOR,
    },
    children: "block",
  },
  row: {
    group: "layout",
    doc: "Horizontal row.",
    props: {
      gap: SPACE(),
      align: oneOf(["start", "center", "end", "baseline"]),
      justify: oneOf(["start", "center", "end", "between"]),
      wrap: flag(),
      anchor: ANCHOR,
    },
    children: "block",
  },
  col: {
    group: "layout",
    doc: "Column inside a row; takes the free width.",
    props: { gap: SPACE(), anchor: ANCHOR },
    children: "block",
  },
  grid: {
    group: "layout",
    doc: "Grid of cells.",
    props: { columns: int(1, 6), gap: SPACE(), anchor: ANCHOR },
    children: "block",
  },
  cell: {
    group: "layout",
    doc: "Grid cell.",
    props: { span: int(1, 6), anchor: ANCHOR },
    children: "block",
  },
  card: {
    group: "layout",
    doc: "Bordered card.",
    props: { title: text(200), anchor: ANCHOR },
    children: "block",
  },
  divider: { group: "layout", doc: "Horizontal rule.", props: {}, children: "none" },
  tabs: {
    group: "layout",
    doc: "Tabs; controlled when value and onchange are set.",
    props: { value: text(200), onchange: handler() },
    children: { only: ["tab"] },
  },
  steps: {
    group: "layout",
    doc: "Timeline of steps, e.g. a cooking schedule. checkable adds a checkbox per step; onchange(doneIndexes).",
    props: {
      checkable: flag(),
      done: prop(
        Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 99 }))).check(
          Schema.isMaxLength(100),
        ),
        "number[] (indexes of finished steps)",
      ),
      onchange: handler(),
    },
    children: { only: ["step"] },
  },
  wizard: {
    group: "layout",
    doc: "One step at a time with Back and Next, e.g. assembly instructions; onchange(index).",
    props: { current: int(0, 99), onchange: handler() },
    children: { only: ["step"] },
  },
  step: {
    group: "layout",
    doc: "One step in steps or wizard: a title, an optional time, any content.",
    props: { title: required(text(120)), time: text(40) },
    children: "block",
  },
  tab: {
    group: "layout",
    doc: "One tab.",
    props: { label: required(text(80)), value: text(200) },
    children: "block",
  },
  disclosure: {
    group: "layout",
    doc: "Collapsible section.",
    props: { label: required(text(200)), open: flag() },
    children: "block",
  },
  popover: {
    group: "layout",
    doc: "Button that opens its content in a small panel.",
    props: { label: required(text(80)), variant: named("variant", VARIANTS) },
    children: "block",
  },

  title: {
    group: "text",
    doc: "Heading.",
    props: { size: oneOf(["sm", "md", "lg"]) },
    children: "inline",
  },
  text: {
    group: "text",
    doc: "Paragraph.",
    props: { tone: named("tone", TONES), size: oneOf(["sm", "md", "lg"]) },
    children: "inline",
  },
  b: { group: "text", doc: "Bold.", props: {}, children: "inline" },
  i: { group: "text", doc: "Italic.", props: {}, children: "inline" },
  code: { group: "text", doc: "Inline code.", props: {}, children: "inline" },
  link: {
    group: "text",
    doc: "Link (http/https), opened after confirmation.",
    props: { href: required(matching(/^https?:\/\//i, "http(s) URL", 2000)) },
    children: "inline",
  },
  badge: {
    group: "text",
    doc: "Small label.",
    props: { tone: named("tone", TONES) },
    children: "inline",
  },
  icon: {
    group: "text",
    doc: "Inline icon; give a label when it carries meaning.",
    props: {
      name: required(named("icon", ICON_NAMES)),
      tone: named("tone", TONES),
      label: text(80),
    },
    children: "none",
  },
  stat: {
    group: "text",
    doc: "Metric with label.",
    props: {
      label: required(text(120)),
      value: required(
        prop(
          Schema.Union([Schema.String.check(Schema.isMaxLength(120)), Schema.Finite]),
          "string | number",
        ),
      ),
      delta: text(60),
      tone: named("tone", TONES),
    },
    children: "none",
  },
  callout: {
    group: "text",
    doc: "Highlighted note.",
    props: { tone: oneOf(["info", "success", "warning", "destructive"]), title: text(200) },
    children: "block",
  },
  list: { group: "text", doc: "List.", props: { ordered: flag() }, children: { only: ["item"] } },
  item: { group: "text", doc: "List item.", props: {}, children: "block" },
  math: {
    group: "text",
    doc: 'TeX formula; write it as a quoted string, e.g. tex="\\frac{\\sigma}{\\sqrt{n}}". display centres it on its own line.',
    props: { tex: required(text(2000)), display: flag() },
    children: "none",
  },
  num: {
    group: "text",
    doc: "Number formatted in the reader's locale.",
    props: {
      value: required(num()),
      format: NUMBER_FORMAT,
    },
    children: "none",
  },
  date: {
    group: "text",
    doc: "Date formatted in the reader's locale.",
    props: {
      value: required(
        prop(
          Schema.Union([Schema.Finite, Schema.String.check(Schema.isMaxLength(40))]),
          "timestamp | ISO string",
        ),
      ),
      format: oneOf(["date", "time", "datetime", "relative"]),
    },
    children: "none",
  },

  button: {
    group: "input",
    doc: "Button.",
    props: {
      onclick: handler(),
      variant: named("variant", VARIANTS),
      disabled: flag(),
    },
    children: "inline",
  },
  timer: {
    group: "input",
    doc: "Countdown with its own controls; without seconds it counts up. ondone() at zero.",
    props: { seconds: int(1, 86_400), label: text(80), ondone: handler() },
    children: "none",
  },
  routine: {
    group: "input",
    doc: "Timed phases in turn from one Start (breathing, intervals), rounds times; ondone() at the end.",
    props: { rounds: int(1, 100), ondone: handler() },
    children: { only: ["phase"] },
  },
  phase: {
    group: "input",
    doc: "Routine phase; children guide it. size 0–1 eases a circle to it over the phase, a breath.",
    props: {
      label: required(text(80)),
      seconds: required(int(1, 3600)),
      tone: named("tone", TONES),
      size: between(0, 1),
    },
    children: "block",
  },
  copy: {
    group: "input",
    doc: "Button that copies its text to the clipboard, e.g. a shopping list.",
    props: {
      text: required(text(4096)),
      variant: named("variant", VARIANTS),
    },
    children: "inline",
  },
  segmented: {
    group: "input",
    doc: "Choice between a few options; onchange(value).",
    props: {
      options: required(
        prop(Schema.Array(option).check(Schema.isMaxLength(12)), "(string | {label, value})[]"),
      ),
      value: text(200),
      onchange: handler(),
    },
    children: "none",
  },
  slider: {
    group: "input",
    doc: "Slider; onchange(value).",
    props: {
      min: required(num()),
      max: required(num()),
      step: num(),
      value: required(num()),
      onchange: handler(),
      label: text(120),
    },
    children: "none",
  },
  input: {
    group: "input",
    doc: "Text input, multiline for a paragraph; onchange(value).",
    props: {
      value: text(2000),
      placeholder: text(200),
      multiline: flag(),
      onchange: handler(),
      label: text(120),
    },
    children: "none",
  },
  datepicker: {
    group: "input",
    doc: "Date picker; onchange(day).",
    props: { value: DAY, min: DAY, max: DAY, onchange: handler(), label: text(120) },
    children: "none",
  },
  number: {
    group: "input",
    doc: "Number input; onchange(value).",
    props: {
      value: num(),
      min: num(),
      max: num(),
      step: num(),
      onchange: handler(),
      label: text(120),
    },
    children: "none",
  },
  quiz: {
    group: "input",
    doc: "Scored quiz, one question at a time; use it for any quiz. more: a follow-up request offered at the end. onchange(answers).",
    props: {
      title: text(120),
      // Offered at the score, e.g. "Another quiz on the dative with harder questions".
      more: text(300),
      answers: prop(
        Schema.Array(Schema.NullOr(Schema.String.check(Schema.isMaxLength(200)))).check(
          Schema.isMaxLength(30),
        ),
        "(string | null)[]",
      ),
      onchange: handler(),
    },
    children: { only: ["question"] },
  },
  question: {
    group: "input",
    doc: "Quiz question: text as children; answer is one of options; feedback explains each option, in order; hint before answering, explain after.",
    props: {
      options: required(
        prop(
          Schema.Array(Schema.String.check(Schema.isMaxLength(200))).check(
            Schema.isMinLength(2),
            Schema.isMaxLength(6),
          ),
          "string[]",
        ),
      ),
      answer: required(text(200)),
      explain: text(500),
      feedback: prop(
        Schema.Array(Schema.String.check(Schema.isMaxLength(300))).check(Schema.isMaxLength(6)),
        "string[]",
      ),
      hint: text(300),
    },
    children: "inline",
  },
  choice: {
    group: "input",
    doc: "Radio buttons; onchange(value).",
    props: {
      options: required(
        prop(Schema.Array(option).check(Schema.isMaxLength(20)), "(string | {label, value})[]"),
      ),
      value: text(200),
      onchange: handler(),
      label: text(200),
    },
    children: "none",
  },
  select: {
    group: "input",
    doc: "Dropdown; onchange(value).",
    props: {
      options: required(
        prop(Schema.Array(option).check(Schema.isMaxLength(100)), "(string | {label, value})[]"),
      ),
      value: text(200),
      onchange: handler(),
      label: text(120),
    },
    children: "none",
  },
  checkbox: {
    group: "input",
    doc: "Checkbox; onchange(checked).",
    props: { checked: flag(), onchange: handler(), label: text(200) },
    children: "none",
  },
  switch: {
    group: "input",
    doc: "Toggle; onchange(checked).",
    props: { checked: flag(), onchange: handler(), label: text(200) },
    children: "none",
  },
  stepper: {
    group: "input",
    doc: "− value + control; onchange(value).",
    props: {
      value: required(num()),
      min: num(),
      max: num(),
      step: num(),
      onchange: handler(),
      label: text(120),
    },
    children: "none",
  },
  celebrate: {
    group: "input",
    doc: "Confetti when `when` turns true as the reader watches, never on reload.",
    props: { when: required(flag()) },
    children: "none",
  },

  suggestions: {
    group: "chat",
    doc: "Follow-up suggestions.",
    props: {},
    children: { only: ["suggestion"] },
  },
  suggestion: {
    group: "chat",
    doc: "A follow-up the reader can send with one click; its text is the message.",
    props: {},
    children: "inline",
  },

  table: {
    group: "data",
    doc: "Table. Pass numbers as numbers: they align, sort and take their column's format.",
    props: {
      columns: required(
        prop(
          Schema.Array(Schema.String.check(Schema.isMaxLength(200))).check(Schema.isMaxLength(20)),
          "string[]",
        ),
      ),
      rows: required(
        prop(
          Schema.Array(Schema.Array(cell).check(Schema.isMaxLength(20))).check(
            Schema.isMaxLength(500),
          ),
          "(string | number | null)[][]",
        ),
      ),
      sortable: flag(),
      formats: prop(
        Schema.Array(Schema.NullOr(NUMBER_FORMAT_SCHEMA)).check(Schema.isMaxLength(20)),
        "(format | null)[]",
      ),
    },
    children: "none",
  },
  progress: {
    group: "data",
    doc: "Progress bar.",
    props: { value: required(between(0, 100)), label: text(120) },
    children: "none",
  },
  chart: {
    group: "data",
    doc: "Chart. pie and donut: one series, x names the slices, past four the smallest fold into Other. scatter: numbers in x.",
    props: {
      type: required(oneOf(["bar", "line", "area", "pie", "donut", "scatter"])),
      x: required(
        prop(
          Schema.Array(
            Schema.Union([Schema.String.check(Schema.isMaxLength(80)), Schema.Finite]),
          ).check(Schema.isMaxLength(500)),
          "(string | number)[]",
        ),
      ),
      series: required(
        prop(
          Schema.Array(
            Schema.Struct({
              name: Schema.String.check(Schema.isMaxLength(80)),
              values: Schema.Array(Schema.Union([Schema.Finite, Schema.Null])).check(
                Schema.isMaxLength(500),
              ),
            }),
          ).check(Schema.isMaxLength(4)),
          // The theme has four chart colours; a fifth series drops the whole chart.
          '{name, values: number[]}[] (at most 4; fold the rest into one "Other" series)',
        ),
      ),
      label: required(text(200)),
      stacked: flag(),
      unit: text(20),
      // The y axis and values, as for <num>: "currency:EUR" labels a money axis "600K €".
      format: NUMBER_FORMAT,
      rules: prop(
        Schema.Array(
          Schema.Struct({
            x: Schema.optionalKey(
              Schema.Union([Schema.String.check(Schema.isMaxLength(80)), Schema.Finite]),
            ),
            y: Schema.optionalKey(Schema.Finite),
            label: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(80))),
          }),
        ).check(Schema.isMaxLength(4)),
        "{x?, y?, label?}[] (dashed reference lines: y for a level such as a mean, x for a category)",
      ),
      xLabel: text(80),
      yLabel: text(80),
    },
    children: "none",
  },

  image: {
    group: "media",
    doc: "Image found by web search for the query.",
    props: {
      query: required(text(200)),
      aspect: matching(/^\d{1,2}:\d{1,2}$/, '"4:3"'),
      caption: text(300),
    },
    children: "none",
  },
  images: {
    group: "media",
    doc: "Several images found by web search.",
    props: {
      query: required(
        prop(
          Schema.Array(Schema.String.check(Schema.isMaxLength(200))).check(Schema.isMaxLength(4)),
          "string[]",
        ),
      ),
      layout: oneOf(["carousel", "grid"]),
      aspect: matching(/^\d{1,2}:\d{1,2}$/, '"1:1"'),
    },
    children: "none",
  },

  map: {
    group: "map",
    doc: "Map that fits its pins, routes and areas; onselect(pinId) when a pin is tapped.",
    props: {
      label: required(text(200)),
      height: int(160, 800),
      zoom: between(1, 18),
      center: prop(
        Schema.Struct({
          lat: Schema.Finite.check(Schema.isBetween({ minimum: -90, maximum: 90 })),
          lng: Schema.Finite.check(Schema.isBetween({ minimum: -180, maximum: 180 })),
        }),
        "{lat, lng}",
      ),
      selected: text(80),
      onselect: handler(),
      anchor: ANCHOR,
    },
    children: { only: ["pin", "route", "area"] },
  },
  pin: {
    group: "map",
    doc: "Marker at a place or lat/lng, labelled on the map. Its content shows when tapped.",
    props: {
      id: text(80),
      place: text(200),
      lat: between(-90, 90),
      lng: between(-180, 180),
      label: text(120),
      icon: EMOJI,
      color: named("mapColor", MAP_COLORS),
    },
    children: "inline",
  },
  route: {
    group: "map",
    doc: "Route through stops.",
    props: {
      stops: required(
        prop(
          Schema.Array(
            Schema.Union([
              Schema.String.check(Schema.isMaxLength(200)),
              Schema.Struct({
                lat: Schema.Finite.check(Schema.isBetween({ minimum: -90, maximum: 90 })),
                lng: Schema.Finite.check(Schema.isBetween({ minimum: -180, maximum: 180 })),
              }),
            ]),
          ).check(Schema.isMinLength(2), Schema.isMaxLength(10)),
          "(string | {lat, lng})[] (2 to 10 stops, written out)",
        ),
      ),
      mode: oneOf(["drive", "walk", "bike", "straight"]),
      label: text(120),
      color: named("mapColor", MAP_COLORS),
    },
    children: "none",
  },
  area: {
    group: "map",
    doc: "Circle around a point, radius in metres.",
    props: {
      lat: required(between(-90, 90)),
      lng: required(between(-180, 180)),
      radius: required(between(10, 200_000)),
      label: text(120),
      color: named("mapColor", MAP_COLORS),
    },
    children: "none",
  },
  svg: {
    group: "svg",
    doc: "Drawing; shapes inside use theme colours.",
    props: {
      viewBox: required(
        matching(/^\s*-?\d+(?:\.\d+)?(?:[\s,]+-?\d+(?:\.\d+)?){3}\s*$/, '"0 0 320 120"'),
      ),
      label: required(text(200)),
      height: between(1, 2000),
    },
    children: "svg",
  },
  g: { group: "svg", doc: "Group.", props: SVG_SHAPE, children: "svg" },
  rect: {
    group: "svg",
    doc: "Rectangle.",
    props: {
      ...SVG_SHAPE,
      x: num(),
      y: num(),
      width: required(num()),
      height: required(num()),
      rx: num(),
      ry: num(),
    },
    children: "none",
  },
  circle: {
    group: "svg",
    doc: "Circle.",
    props: { ...SVG_SHAPE, cx: num(), cy: num(), r: required(num()) },
    children: "none",
  },
  ellipse: {
    group: "svg",
    doc: "Ellipse.",
    props: { ...SVG_SHAPE, cx: num(), cy: num(), rx: required(num()), ry: required(num()) },
    children: "none",
  },
  line: {
    group: "svg",
    doc: "Line.",
    props: { ...SVG_SHAPE, x1: num(), y1: num(), x2: num(), y2: num() },
    children: "none",
  },
  polyline: {
    group: "svg",
    doc: "Open polyline.",
    props: { ...SVG_SHAPE, points: required(POINTS) },
    children: "none",
  },
  polygon: {
    group: "svg",
    doc: "Closed polygon.",
    props: { ...SVG_SHAPE, points: required(POINTS) },
    children: "none",
  },
  path: {
    group: "svg",
    doc: "Path.",
    props: {
      ...SVG_SHAPE,
      d: required(
        matching(/^[MmLlHhVvCcSsQqTtAaZz\d\s,.eE+-]*$/, "path data", TREE_LIMITS.pathChars),
      ),
    },
    children: "none",
  },
};

/** `<text>` inside an `<svg>` is SVG text, not a paragraph. */
const SVG_TEXT: TagSpec = {
  group: "svg",
  doc: "Text in a drawing.",
  props: {
    x: num(),
    y: num(),
    fontSize: between(1, 200),
    textAnchor: oneOf(["start", "middle", "end"]),
    fill: named("paint", SVG_PAINT),
    opacity: between(0, 1),
  },
  children: "plain",
};

export interface ValidNode {
  readonly tag: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: readonly (ValidNode | string)[];
}

export interface TreeDiagnostic {
  readonly action: DiagnosticAction;
  readonly code: string;
  readonly detail: string;
}

/** Every string a prop carries, as the reader will see it. */
function visible(value: unknown): unknown {
  if (typeof value === "string") return stripHiddenText(value);
  if (Array.isArray(value)) return value.map(visible);
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visible(v)]));
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class Validator {
  readonly diagnostics: TreeDiagnostic[] = [];
  private nodes = 0;
  private svgNodes = 0;

  private report(action: DiagnosticAction, code: string, detail: string): void {
    if (this.diagnostics.length < 50) this.diagnostics.push({ action, code, detail });
  }

  list(
    raw: readonly unknown[],
    parent: Children,
    inSvg: boolean,
    depth: number,
  ): (ValidNode | string)[] {
    const out: (ValidNode | string)[] = [];
    for (const child of raw) {
      if (typeof child === "string") {
        if (child.length > TREE_LIMITS.stringChars) {
          this.report("omitted_node", "string_too_long", `${child.length} chars`);
          continue;
        }
        // Text is only meaningful where inline content is; elsewhere it is
        // layout whitespace or a mistake.
        if (parent === "inline" || parent === "block" || parent === "plain") {
          out.push(stripHiddenText(child));
        } else if (child.trim() !== "")
          this.report("omitted_node", "text_not_allowed", child.slice(0, 40));
        continue;
      }
      const node = this.node(child, parent, inSvg, depth);
      if (node) out.push(node);
    }
    return out;
  }

  private node(raw: unknown, parent: Children, inSvg: boolean, depth: number): ValidNode | null {
    if (!isRecord(raw) || typeof raw.tag !== "string" || !Array.isArray(raw.children)) {
      this.report("omitted_node", "malformed_node", typeof raw);
      return null;
    }
    const tag = raw.tag;
    // Own keys only: a tag named after a prototype member is just unknown.
    const spec =
      inSvg && tag === "text" ? SVG_TEXT : Object.hasOwn(CATALOG, tag) ? CATALOG[tag] : undefined;
    if (!spec) {
      this.report("omitted_node", "unknown_tag", tag);
      return null;
    }
    if (!this.allowed(tag, spec, parent, inSvg)) {
      this.report("omitted_node", "not_allowed_here", tag);
      return null;
    }
    if (depth >= TREE_LIMITS.depth || ++this.nodes > TREE_LIMITS.nodes) {
      this.report("omitted_node", "tree_too_large", tag);
      return null;
    }
    if (spec.group === "svg" && ++this.svgNodes > TREE_LIMITS.svgNodes) {
      this.report("omitted_node", "drawing_too_large", tag);
      return null;
    }
    const props: Record<string, unknown> = {};
    const given = isRecord(raw.props) ? raw.props : {};
    for (const [name, value] of Object.entries(given)) {
      const propSpec = Object.hasOwn(spec.props, name) ? spec.props[name] : undefined;
      if (!propSpec) {
        this.report("dropped_prop", "unknown_prop", `${tag}.${name}`);
        continue;
      }
      if (value === undefined || value === null) continue;
      const decoded = propSpec.decode(value);
      if (Option.isNone(decoded)) {
        this.report("dropped_prop", "invalid_prop", `${tag}.${name}`);
        continue;
      }
      props[name] = visible(decoded.value);
    }
    for (const [name, propSpec] of Object.entries(spec.props)) {
      if (propSpec.required && !(name in props)) {
        this.report("omitted_node", "missing_prop", `${tag}.${name}`);
        return null;
      }
    }
    const children = this.list(raw.children, spec.children, inSvg || tag === "svg", depth + 1);
    return { tag, props, children };
  }

  private allowed(tag: string, spec: TagSpec, parent: Children, inSvg: boolean): boolean {
    if (typeof parent === "object") return parent.only.includes(tag);
    switch (parent) {
      case "none":
      case "plain":
        return false;
      case "inline":
        return INLINE_TAGS.has(tag);
      case "svg":
        return inSvg && spec.group === "svg" && tag !== "svg";
      case "block":
        return spec.group !== "svg" || tag === "svg";
    }
  }
}

/**
 * Validates a tree from the runtime. Everything not in the catalog is
 * dropped with a diagnostic, so React only ever sees known tags with props
 * of the declared types.
 */
export function validateTree(raw: readonly unknown[]): {
  nodes: (ValidNode | string)[];
  diagnostics: TreeDiagnostic[];
} {
  const validator = new Validator();
  const nodes = validator.list(raw, "block", false, 0);
  return { nodes, diagnostics: validator.diagnostics };
}

const GROUP_ORDER: readonly TagGroup[] = [
  "layout",
  "text",
  "input",
  "data",
  "media",
  "map",
  "chat",
  "svg",
];

const GROUP_TITLES: Record<TagGroup, string> = {
  layout: "Layout",
  text: "Text",
  input: "Inputs",
  data: "Data",
  media: "Images",
  map: "Maps (pins and routes go inside <map>)",
  chat: "Follow-ups",
  svg: "Drawing (inside <svg> only)",
};

function signature(tag: string, spec: TagSpec, shared: ReadonlySet<string> = new Set()): string {
  const props = Object.entries(spec.props)
    .filter(([name]) => !shared.has(name))
    .map(([name, p]) => `${name}${p.required ? "" : "?"}: ${p.type}`);
  return `<${tag}${props.length > 0 ? ` ${props.join(", ")}` : ""}>`;
}

// Every shape takes the same paint props; listing them once keeps the skill short.
const SHAPE_PROPS = new Set(Object.keys(SVG_SHAPE));
const SHAPE_NOTE = `Every shape below also takes ${Object.entries(SVG_SHAPE)
  .map(([name, p]) => `${name}?: ${p.type}`)
  .join(", ")}.`;

/** The catalog as reference text for the skill. Stable: generated, never edited. */
const quote = (values: readonly string[]) => values.map((v) => `"${v}"`).join(" | ");
const LEGEND = [
  `tone: ${quote(TONES)}`,
  `variant: ${quote(VARIANTS)}`,
  `paint: ${quote(SVG_PAINT)}`,
  `mapColor: ${quote(MAP_COLORS)}`,
  `format: ${FORMAT_LEGEND}`,
  `icon: ${ICON_NAMES.join(", ")}`,
].join("\n");

export function catalogReference(): string {
  const sections: string[] = [`Named values:\n${LEGEND}`];
  for (const group of GROUP_ORDER) {
    const lines = Object.entries(CATALOG)
      .filter(([, spec]) => spec.group === group)
      .map(
        ([tag, spec]) =>
          `- ${signature(tag, spec, tag === "svg" ? undefined : group === "svg" ? SHAPE_PROPS : undefined)} ${spec.doc}`,
      );
    if (group === "svg") {
      lines.splice(1, 0, SHAPE_NOTE);
      lines.push(`- ${signature("text", SVG_TEXT)} ${SVG_TEXT.doc}`);
    }
    sections.push(`### ${GROUP_TITLES[group]}\n${lines.join("\n")}`);
  }
  return sections.join("\n\n");
}
