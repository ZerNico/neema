import type { Editor } from "@tiptap/core";
import { renderToString } from "katex";

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );

/** A file name the browser and the print dialog both accept. */
export const fileName = (title: string) =>
  title
    .replace(/[\\/:*?"<>|]+/g, " ")
    .trim()
    .slice(0, 120) || "Document";

// Print on paper: the app's theme does not apply, and nothing interactive shows.
// No page margin, where the browser prints its own date and title header; the
// body's padding, cloned onto every page, is the margin. Whitespace is kept
// as the editor keeps it, since line breaks are text.
const PRINT_CSS = `
@page { margin: 0; }
html { color: #111; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font: 11pt/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 18mm 16mm; box-decoration-break: clone; -webkit-box-decoration-break: clone; white-space: pre-wrap; overflow-wrap: break-word; }
h1.title { font-size: 20pt; margin: 0 0 14pt; }
h1 { font-size: 17pt; } h2 { font-size: 14pt; } h3 { font-size: 12pt; }
h1, h2, h3 { line-height: 1.25; margin: 16pt 0 6pt; break-after: avoid; }
p { margin: 0 0 7pt; }
ul, ol { margin: 0 0 7pt; padding-left: 18pt; }
li > p { margin: 0 0 2pt; }
ul[data-type="taskList"] { list-style: none; padding-left: 0; }
ul[data-type="taskList"] li { display: flex; gap: 6pt; align-items: baseline; }
ul[data-type="taskList"] li > label { flex: none; }
ul[data-type="taskList"] li[data-checked="true"] > div { color: #666; text-decoration: line-through; }
blockquote { margin: 0 0 7pt; padding-left: 10pt; border-left: 2pt solid #ccc; color: #444; }
pre { background: #f4f4f5; border-radius: 4pt; padding: 8pt 10pt; white-space: pre-wrap; font-size: 9.5pt; break-inside: avoid; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
:not(pre) > code { background: #f4f4f5; border-radius: 3pt; padding: 0 3pt; }
table { border-collapse: collapse; width: 100%; margin: 0 0 9pt; break-inside: auto; }
tr { break-inside: avoid; }
th, td { border: 0.75pt solid #d4d4d8; padding: 4pt 6pt; text-align: left; vertical-align: top; }
th { background: #f4f4f5; }
th p, td p { margin: 0; }
hr { border: 0; border-top: 0.75pt solid #d4d4d8; margin: 12pt 0; }
a { color: inherit; }
[data-pending] { display: none; }
figure.diagram { margin: 0 0 9pt; text-align: center; break-inside: avoid; white-space: normal; }
figure.diagram svg { max-width: 100%; height: auto; }
.formula { margin: 0 0 9pt; text-align: center; break-inside: avoid; }
h4, h5, h6 { font-size: 11pt; line-height: 1.25; margin: 12pt 0 4pt; break-after: avoid; }
[data-callout] { margin: 0 0 9pt; padding: 6pt 10pt; border-left: 3pt solid #888; background: #f4f4f5; break-inside: avoid; }
[data-callout="note"] { border-color: #2563eb; } [data-callout="tip"] { border-color: #16a34a; }
[data-callout="important"] { border-color: #7c3aed; } [data-callout="warning"] { border-color: #d97706; }
[data-callout="caution"] { border-color: #dc2626; }
[data-callout] > :last-child { margin-bottom: 0; }
details { margin: 0 0 9pt; } summary { font-weight: 600; margin: 0 0 4pt; list-style: none; }
body { counter-reset: footnote; }
sup[data-footnote] { counter-increment: footnote; }
sup[data-footnote]::after { content: counter(footnote); font-size: 0.75em; }
mark { background: #fef08a; color: inherit; }
img { max-width: 100%; height: auto; vertical-align: bottom; }
[data-sheet-embed] { margin: 0 0 9pt; break-inside: avoid; white-space: normal; }
[data-sheet-embed] .sheet-embed-caption { font-size: 9pt; color: #555; margin: 0 0 3pt; }
[data-sheet-embed] table { width: auto; }
[data-sheet-embed] td { padding: 2pt 5pt; white-space: pre; }
[data-sheet-embed] svg { max-width: 100%; height: auto; }
ol.footnotes { margin: 18pt 0 0; padding: 8pt 0 0 18pt; border-top: 0.75pt solid #d4d4d8; font-size: 9.5pt; }
`;

/**
 * The document as a page to print or save as PDF, through the browser's own
 * dialog: it lays out pages, breaks and fonts better than anything we would
 * draw ourselves, and works the same in the desktop app.
 */
export const printDocument = (editor: Editor, title: string) => {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, {
    position: "fixed",
    right: "0",
    bottom: "0",
    width: "0",
    height: "0",
    border: "0",
  });
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(fileName(title))}</title><style>${PRINT_CSS}</style></head><body><h1 class="title">${escapeHtml(title)}</h1>${editor.getHTML()}</body></html>`;
  frame.addEventListener("load", () => {
    const view = frame.contentWindow;
    const page = frame.contentDocument;
    if (!view || !page) return frame.remove();
    // Dates print as a reader would say them, not as stored.
    for (const chip of page.querySelectorAll<HTMLElement>("[data-date-chip]")) {
      const value = chip.dataset.value;
      if (value)
        chip.textContent = new Date(`${value}T00:00:00`).toLocaleDateString(undefined, {
          day: "numeric",
          month: "short",
          year: "numeric",
        });
    }
    // Formulas print as MathML, which the browser draws without KaTeX's stylesheet.
    for (const formula of page.querySelectorAll<HTMLElement>("[data-latex]")) {
      const display = formula.dataset.type === "block-math";
      formula.innerHTML = renderToString(formula.dataset.latex ?? "", {
        displayMode: display,
        output: "mathml",
        throwOnError: false,
      });
      if (display) formula.className = "formula";
    }
    // Footnotes print as numbers in the text and their notes at the end, as a word processor's do.
    const notes = [...page.querySelectorAll<HTMLElement>("sup[data-footnote]")];
    if (notes.length) {
      const list = page.createElement("ol");
      list.className = "footnotes";
      for (const note of notes) {
        const item = page.createElement("li");
        item.textContent = note.dataset.note ?? "";
        list.append(item);
      }
      page.body.append(list);
    }
    // Diagrams print as the editor drew them, matched to their source.
    const drawn = new Map<string, string>();
    // One still showing an older version of its source is left as code.
    for (const diagram of editor.view.dom.querySelectorAll('[data-diagram=""]')) {
      const source = diagram.parentElement?.querySelector("pre")?.textContent;
      const svg = diagram.querySelector("svg");
      if (source && svg) drawn.set(source, svg.outerHTML);
    }
    for (const code of page.querySelectorAll("pre > code.language-mermaid")) {
      const svg = drawn.get(code.textContent ?? "");
      if (!svg) continue;
      const figure = page.createElement("figure");
      figure.className = "diagram";
      figure.innerHTML = svg;
      code.parentElement!.replaceWith(figure);
    }
    void printSheetEmbeds(editor, page).finally(() => {
      view.addEventListener("afterprint", () => frame.remove(), { once: true });
      view.focus();
      view.print();
    });
  });
  document.body.append(frame);
};

/** What an embed shows, the same on the printed element and the editor's drawing of it. */
const embedKey = (element: HTMLElement) =>
  [element.dataset.sheet, element.dataset.range ?? "", element.dataset.chart ?? ""].join("\u0000");

/**
 * Sheet embeds print what the editor drew of them: a range as its table, a
 * chart as an SVG of the drawing. One not drawn keeps its caption line.
 */
const printSheetEmbeds = async (editor: Editor, page: Document) => {
  const printed = [...page.querySelectorAll<HTMLElement>("[data-sheet-embed]")];
  if (!printed.length) return;
  const views = [...editor.view.dom.querySelectorAll<HTMLElement>("[data-sheet-embed-view]")];
  const drawn = new Map(views.map((view) => [embedKey(view), view]));
  // The chart library's exporter loads only for a document that prints a chart.
  const charts = views.some((view) => view.querySelector("figure[data-chart-id]"))
    ? await import("../sheet/ui/chart-image.ts")
    : null;
  for (const embed of printed) {
    const view = drawn.get(embedKey(embed));
    if (!view) continue;
    const caption = view.querySelector(".sheet-embed-caption")?.textContent;
    const line = embed.querySelector(".sheet-embed-caption");
    if (caption && line) line.textContent = caption;
    const table = view.querySelector("table");
    const figure = view.querySelector<HTMLElement>("figure[data-chart-id]");
    if (table) embed.append(page.importNode(table, true));
    else if (figure && charts) embed.insertAdjacentHTML("beforeend", charts.chartSvg(figure));
  }
};

/** The document's Markdown as a `.md` file. */
export const downloadMarkdown = (markdown: string, title: string) => {
  const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${fileName(title)}.md`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
};
