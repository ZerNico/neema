import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WordPreview } from "./word-preview.tsx";

afterEach(() => vi.unstubAllGlobals());

it("lays out headings, formatted runs, lists and tables as text, never markup", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        blocks: [
          { type: "paragraph", role: "title", runs: [{ text: "Report" }] },
          { type: "paragraph", role: "heading", level: 2, runs: [{ text: "Summary" }] },
          {
            type: "paragraph",
            role: "body",
            align: "center",
            runs: [{ text: "Grew " }, { text: "<b>12%</b>", bold: true }],
          },
          { type: "paragraph", role: "list", level: 1, marker: "2.", runs: [{ text: "North" }] },
          {
            type: "paragraph",
            role: "heading",
            level: 1,
            look: { color: "#1F3864", size: 18, font: "Georgia", bold: false },
            runs: [{ text: "Styled", color: "red; background: url(x)" }],
          },
          { type: "pageBreak" },
          {
            type: "tableOfContents",
            entries: [
              { level: 1, text: "Report" },
              { level: 2, text: "Summary" },
            ],
          },
          {
            type: "paragraph",
            role: "body",
            runs: [],
            pictures: [
              { width: 4, height: 2, alt: "Chart", src: "data:image/png;base64,iVBORw0KGgo=" },
              { width: 4, height: 2, alt: "Script", src: "javascript:alert(1)" },
              { width: 400, height: 200, alt: "Big" },
            ],
          },
          {
            type: "table",
            rows: [
              ["Region", "Revenue"],
              ["North", "120"],
            ],
          },
        ],
        truncated: true,
      }),
    ),
  );
  render(<WordPreview source={{ kind: "attachment", id: "doc" }} />);
  expect(await screen.findByRole("heading", { level: 2, name: "Summary" })).toBeInTheDocument();
  // Text from the file is shown as text: the tags are characters, not elements.
  const bold = screen.getByText("<b>12%</b>");
  expect(bold).toHaveClass("font-semibold");
  expect(bold.querySelector("b")).toBeNull();
  expect(bold.closest("p")).toHaveClass("text-center");
  expect(screen.getByRole("cell", { name: "Revenue" })).toHaveClass("font-semibold");
  expect(screen.getByRole("separator")).toBeInTheDocument();
  // Numbered items show their number; a heading carries the document's own look.
  expect(screen.getByText("2.")).toBeInTheDocument();
  const styled = screen.getByRole("heading", { name: "Styled" });
  expect(styled.style.color).toBe("rgb(31, 56, 100)");
  expect(styled.style.fontSize).toBe("23px");
  expect(styled.style.fontFamily).toContain("Georgia");
  expect(styled.style.fontWeight).toBe("400");
  // A colour that isn't plain hex is dropped.
  expect(screen.getByText("Styled").style.color).toBe("");
  expect(screen.getByRole("navigation", { name: "Table of contents" })).toHaveTextContent(
    /ReportSummary/,
  );
  // A PNG from the server is drawn; anything else it sent as a source never is.
  expect(screen.getByRole("img", { name: "Chart" })).toHaveAttribute(
    "src",
    "data:image/png;base64,iVBORw0KGgo=",
  );
  expect(screen.getByRole("img", { name: "Script" })).not.toHaveAttribute("src");
  expect(screen.getByRole("img", { name: "Big" }).tagName).toBe("SPAN");
  expect(
    screen.getByText(/Showing the start of this document\. 2 pictures aren’t shown here\./),
  ).toBeInTheDocument();
});

it("reports a document it cannot load", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("nope", { status: 422 })),
  );
  render(<WordPreview source={{ kind: "attachment", id: "doc" }} />);
  expect(await screen.findByText(/Could not load this document/)).toBeInTheDocument();
});
