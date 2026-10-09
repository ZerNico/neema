import type { Editor } from "@tiptap/core";

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
const PRINT_CSS = `
@page { margin: 18mm 16mm; }
html { color: #111; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font: 11pt/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; }
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
    view.addEventListener("afterprint", () => frame.remove(), { once: true });
    view.focus();
    view.print();
  });
  document.body.append(frame);
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
