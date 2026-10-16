import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SpreadsheetPreview as Preview } from "~/modules/spreadsheets/preview.ts";
import { SpreadsheetPreview } from "./spreadsheet-preview.tsx";

afterEach(() => vi.unstubAllGlobals());

const sheet = (name: string, over: Partial<Preview> = {}): Preview => ({
  sheets: [{ name: "Data" }, { name: "Summary" }, { name: "Secret", hidden: true }],
  sheet: name,
  rows: 2,
  cols: 2,
  cells: [],
  styles: [],
  widths: [],
  heights: [],
  merges: [],
  hiddenRows: [],
  hiddenCols: [],
  conditional: [],
  charts: [],
  otherCharts: 0,
  images: [],
  truncated: false,
  ...over,
});

it("shows a sheet's stored values in a grid, its formulas above, and switches sheets", async () => {
  const fetch = vi.fn(async (url: string) =>
    Response.json(
      url.endsWith("?sheet=Summary")
        ? sheet("Summary", { cells: [{ row: 1, col: 1, value: "Total" }] })
        : sheet("Data", {
            cells: [
              { row: 1, col: 1, value: "Month", style: 0 },
              { row: 2, col: 1, value: 3, formula: "=1+2" },
            ],
            styles: [{ bold: true }],
            charts: [{ index: 0, row: 1, col: 2, x: 0, y: 0, width: 200, height: 100 }],
            otherCharts: 1,
            truncated: true,
          }),
    ),
  );
  vi.stubGlobal("fetch", fetch);
  render(<SpreadsheetPreview source={{ kind: "attachment", id: "book" }} />);
  expect(await screen.findByRole("gridcell", { name: "Month" })).toBeInTheDocument();
  const bar = screen.getByRole("textbox", { name: "Formula bar" });
  expect(bar).toHaveValue("Month");
  // The active cell's formula, as the file stored it, while the grid shows its result.
  fireEvent.keyDown(screen.getByRole("grid"), { key: "ArrowDown" });
  await waitFor(() => expect(bar).toHaveValue("=1+2"));
  expect(screen.getByRole("gridcell", { name: "3" })).toBeInTheDocument();
  // A chart the server draws is an image laid where it sits; one it cannot is counted.
  expect(screen.getByRole("img", { name: "Chart 1 on Data" })).toHaveAttribute(
    "src",
    "/api/spreadsheets/attachment/book?sheet=Data&chart=0",
  );
  expect(
    screen.getByText(/Showing the start of this sheet\. A chart isn’t shown here\./),
  ).toBeInTheDocument();
  // Outside a chat there is nobody to comment to.
  expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
  // Hidden sheets are not offered as tabs.
  expect(screen.queryByRole("button", { name: "Secret" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Summary" }));
  expect(await screen.findByRole("gridcell", { name: "Total" })).toBeInTheDocument();
  expect(fetch).toHaveBeenLastCalledWith(
    "/api/spreadsheets/attachment/book?sheet=Summary",
    expect.anything(),
  );
});

it("sends a comment on the selected cells, quoting them, and keeps it when it cannot go", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        sheet("Data", {
          cells: [
            { row: 1, col: 1, value: "Month" },
            { row: 1, col: 2, value: 4 },
          ],
        }),
      ),
    ),
  );
  const onComment = vi.fn(async () => true).mockResolvedValueOnce(false);
  render(<SpreadsheetPreview source={{ kind: "attachment", id: "book" }} onComment={onComment} />);
  await screen.findByRole("gridcell", { name: "Month" });
  fireEvent.keyDown(screen.getByRole("grid"), { key: "ArrowRight", shiftKey: true });
  fireEvent.click(screen.getByRole("button", { name: "Comment" }));
  const box = await screen.findByRole("textbox", { name: "Comment on A1:B1" });
  fireEvent.change(box, { target: { value: "Make it 5" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => expect(onComment).toHaveBeenCalledWith("Data!A1:B1", "Make it 5"));
  // Not sent: the words stay to try again.
  expect(screen.getByRole("textbox", { name: "Comment on A1:B1" })).toHaveValue("Make it 5");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(onComment).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole("textbox", { name: /Comment on/ })).toBeNull());
});

it("copies and comments on whole columns from the right-click menu", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        sheet("Data", {
          cells: [
            { row: 1, col: 2, value: "Price" },
            { row: 2, col: 2, value: 4 },
          ],
        }),
      ),
    ),
  );
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  const onComment = vi.fn(async () => true);
  render(<SpreadsheetPreview source={{ kind: "attachment", id: "book" }} onComment={onComment} />);
  await screen.findByRole("gridcell", { name: "Price" });
  const header = screen.getByRole("columnheader", { name: "B" });
  fireEvent.pointerDown(header, { button: 2 });
  fireEvent.pointerUp(window);
  fireEvent.contextMenu(header);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Copy" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  expect(writeText.mock.calls[0]).toEqual(["Price\n4"]);
  fireEvent.contextMenu(header);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Comment on B:B" }));
  const box = await screen.findByRole("textbox", { name: "Comment on B:B" });
  fireEvent.change(box, { target: { value: "Add tax" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => expect(onComment).toHaveBeenCalledWith("Data!B:B", "Add tax"));
});

it("moves focus where the menu sends it, and works from the keyboard alone", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(sheet("Data", { cells: [{ row: 1, col: 1, value: "Price" }] })),
    ),
  );
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn(async () => {}) } });
  const onComment = vi.fn(async () => true);
  render(<SpreadsheetPreview source={{ kind: "attachment", id: "book" }} onComment={onComment} />);
  await screen.findByRole("gridcell", { name: "Price" });
  const grid = screen.getByRole("grid");
  // Shift+F10 or the menu key: the browser fires contextmenu on the focused grid.
  grid.focus();
  fireEvent.contextMenu(grid);
  await screen.findByRole("menu");
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(grid).toHaveFocus());
  fireEvent.contextMenu(grid);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Copy" }));
  await waitFor(() => expect(grid).toHaveFocus());
  fireEvent.contextMenu(grid);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Comment on A1" }));
  const box = await screen.findByRole("textbox", { name: "Comment on A1" });
  await waitFor(() => expect(box).toHaveFocus());
  fireEvent.keyDown(box, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Comment on A1" })).toBeNull());
});

it("reports a workbook it cannot load", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("nope", { status: 422 })),
  );
  render(<SpreadsheetPreview source={{ kind: "project-version", id: "v1" }} />);
  await waitFor(() => expect(screen.getByText(/Could not load this workbook/)).toBeInTheDocument());
});
