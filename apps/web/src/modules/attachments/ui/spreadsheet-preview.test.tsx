import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SpreadsheetPreview } from "./spreadsheet-preview.tsx";

afterEach(() => vi.unstubAllGlobals());

const sheet = (name: string, rows: unknown[][], extra: Record<string, unknown> = {}) => ({
  sheets: [{ name: "Data" }, { name: "Summary" }, { name: "Secret", hidden: true }],
  sheet: name,
  rows,
  columnWidths: [12, null],
  merged: [],
  charts: 0,
  truncated: false,
  ...extra,
});

it("shows a sheet as a grid, merges and safe colours included, and switches sheets", async () => {
  const fetch = vi.fn(async (url: string) =>
    Response.json(
      url.endsWith("?sheet=Summary")
        ? sheet("Summary", [[{ text: "Total" }, { text: "60" }]])
        : sheet(
            "Data",
            [
              [
                { text: "Month", bold: true, fill: "#DDEEFF", color: "red; background: url(x)" },
                null,
              ],
              [{ text: "Jan" }, { text: "10", align: "right" }],
            ],
            { merged: ["A1:B1"], charts: 1, otherCharts: 1, truncated: true },
          ),
    ),
  );
  vi.stubGlobal("fetch", fetch);
  render(<SpreadsheetPreview source={{ kind: "attachment", id: "book" }} />);
  const header = await screen.findByRole("cell", { name: "Month" });
  expect(header).toHaveAttribute("colspan", "2");
  expect(header).toHaveClass("font-semibold");
  // A fill in hex is applied; anything else the server sent as a colour is not.
  expect(header.style.backgroundColor).toBe("rgb(221, 238, 255)");
  expect(header.style.color).toBe("");
  // A chart the server draws is an image of this sheet's chart; one it cannot is counted.
  expect(screen.getByRole("img", { name: "Chart 1 on Data" })).toHaveAttribute(
    "src",
    "/api/spreadsheets/attachment/book?sheet=Data&chart=0",
  );
  expect(
    screen.getByText(/Showing the start of this sheet\. A chart isn’t shown here\./),
  ).toBeInTheDocument();
  // Hidden sheets are not offered as tabs.
  expect(screen.queryByRole("button", { name: "Secret" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Summary" }));
  expect(await screen.findByRole("cell", { name: "Total" })).toBeInTheDocument();
  expect(fetch).toHaveBeenLastCalledWith(
    "/api/spreadsheets/attachment/book?sheet=Summary",
    expect.anything(),
  );
});

it("reports a workbook it cannot load", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("nope", { status: 422 })),
  );
  render(<SpreadsheetPreview source={{ kind: "project-version", id: "v1" }} />);
  await waitFor(() => expect(screen.getByText(/Could not load this workbook/)).toBeInTheDocument());
});
