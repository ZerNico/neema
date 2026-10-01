import { useState } from "react";
import { FieldError } from "~/ui/primitives/field";
import { Spinner } from "~/ui/primitives/spinner";
import { SegmentedControl, SegmentedControlItem } from "~/ui/segmented-control.tsx";
import { cn } from "~/ui/utils";
import type { OfficeFile } from "./office-preview.ts";
import { usePreviewJson } from "./use-preview-json.ts";

interface PreviewCell {
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly color?: string;
  readonly fill?: string;
  readonly align?: "left" | "center" | "right";
}
interface Preview {
  readonly sheets: ReadonlyArray<{ name: string; hidden?: boolean }>;
  readonly sheet: string;
  readonly rows: ReadonlyArray<ReadonlyArray<PreviewCell | null>>;
  readonly columnWidths: ReadonlyArray<number | null>;
  readonly merged: ReadonlyArray<string>;
  /** Charts on this sheet the server draws, fetched one image each. */
  readonly charts: number;
  /** Charts it cannot draw (newer chart kinds, or past the limit). */
  readonly otherCharts?: number;
  readonly truncated: boolean;
}

// The server sends plain hex; anything else is dropped rather than styled.
const hex = (value: string | undefined) =>
  value && /^#[0-9A-F]{6}$/i.test(value) ? value : undefined;
const letters = (index: number) => {
  let text = "";
  for (let rest = index; rest > 0; rest = Math.floor((rest - 1) / 26))
    text = String.fromCharCode(65 + ((rest - 1) % 26)) + text;
  return text;
};
/** A stored column width in characters to pixels at 100%; stored widths include Excel's padding. */
const pixels = (width: number | null) => (width === null ? 64 : Math.trunc(width * 7 + 0.5));
/** "B2" as a 0-based row and column. */
const cellAt = (ref: string) => {
  const match = /^([A-Z]+)(\d+)$/.exec(ref)!;
  const column = [...match[1]!].reduce(
    (total, letter) => total * 26 + letter.charCodeAt(0) - 64,
    0,
  );
  return { row: Number(match[2]) - 1, column: column - 1 };
};
/** "B2:C3" as 0-based corners. */
const corners = (range: string) => {
  const [from, to = from] = range.split(":");
  return { from: cellAt(from!), to: cellAt(to!) };
};

const isPreview = (data: unknown): data is Preview =>
  !!data &&
  typeof data === "object" &&
  Array.isArray((data as Preview).rows) &&
  Array.isArray((data as Preview).sheets) &&
  typeof (data as Preview).sheet === "string";
const decodePreview = (data: unknown) => (isPreview(data) ? data : null);

/** One sheet of an authorized workbook as a read-only grid; tabs switch sheets. */
export function SpreadsheetPreview({ source }: { source: OfficeFile }) {
  const base = `/api/spreadsheets/${source.kind}/${encodeURIComponent(source.id)}`;
  // A picked tab belongs to its workbook; another file starts at its own first sheet.
  const [picked, setPicked] = useState<{ base: string; sheet: string }>();
  const sheet = picked?.base === base ? picked.sheet : null;
  const url = sheet === null ? base : `${base}?sheet=${encodeURIComponent(sheet)}`;
  const state = usePreviewJson(url, decodePreview);
  const preview = state.status === "ready" ? state.preview : null;
  // The tabs stay while another sheet loads or fails, so a person can always go back.
  const [known, setKnown] = useState<{ base: string; sheets: Preview["sheets"] }>();
  if (preview && (known?.base !== base || known.sheets !== preview.sheets))
    setKnown({ base, sheets: preview.sheets });
  const sheets = preview?.sheets ?? (known?.base === base ? known.sheets : []);

  if (state.status === "error" && sheets.length === 0)
    return (
      <FieldError>
        Could not load this workbook. Download the original to open it elsewhere.
      </FieldError>
    );
  const visible = sheets.filter((each) => !each.hidden);
  const width = preview?.rows.reduce((max, row) => Math.max(max, row.length), 0) ?? 0;
  // Cells covered by a merge are skipped; the merge's top-left spans them. Each
  // merge is clipped to the grid, whatever the server sent.
  const spans = new Map<string, { rows: number; columns: number }>();
  const covered = new Set<string>();
  for (const range of preview?.merged ?? []) {
    const { from, to: corner } = corners(range);
    const to = {
      row: Math.min(corner.row, preview!.rows.length - 1),
      column: Math.min(corner.column, width - 1),
    };
    spans.set(`${from.row}:${from.column}`, {
      rows: to.row - from.row + 1,
      columns: to.column - from.column + 1,
    });
    for (let row = from.row; row <= to.row; row++)
      for (let column = from.column; column <= to.column; column++)
        if (row !== from.row || column !== from.column) covered.add(`${row}:${column}`);
  }
  return (
    <div className="min-w-0 space-y-2">
      {visible.length > 1 ? (
        <div className="overflow-x-auto">
          <SegmentedControl
            aria-label="Sheet"
            value={[preview?.sheet ?? sheet ?? ""]}
            multiple={false}
            onValueChange={(value) => {
              if (value[0]) setPicked({ base, sheet: value[0] });
            }}
          >
            {visible.map((each) => (
              <SegmentedControlItem key={each.name} value={each.name}>
                {each.name}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </div>
      ) : null}
      <div className="bg-muted/40 relative max-h-[60vh] min-h-40 overflow-auto rounded-xl border">
        {state.status === "error" ? (
          <div className="p-4">
            <FieldError>
              Could not load this sheet. Download the original to open it elsewhere.
            </FieldError>
          </div>
        ) : !preview ? (
          <Spinner
            aria-label="Loading workbook"
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
          />
        ) : preview.rows.length === 0 ? (
          <p className="text-muted-foreground p-4 text-sm">This sheet is empty.</p>
        ) : (
          <table className="border-collapse text-xs" aria-label={`Sheet ${preview.sheet}`}>
            <thead>
              <tr>
                <th className="bg-muted sticky top-0 left-0 z-20 border" />
                {Array.from({ length: width }, (_, column) => (
                  <th
                    key={column}
                    scope="col"
                    className="bg-muted text-muted-foreground sticky top-0 z-10 border px-2 font-normal"
                    style={{ minWidth: pixels(preview.columnWidths[column] ?? null) }}
                  >
                    {letters(column + 1)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row, rowIndex) => (
                // oxlint-disable-next-line react/no-array-index-key -- a grid row is its row number
                <tr key={rowIndex}>
                  <th
                    scope="row"
                    className="bg-muted text-muted-foreground sticky left-0 z-10 border px-2 text-right font-normal"
                  >
                    {rowIndex + 1}
                  </th>
                  {Array.from({ length: width }, (_, column) => {
                    const key = `${rowIndex}:${column}`;
                    if (covered.has(key)) return null;
                    const cell = row[column] ?? null;
                    const span = spans.get(key);
                    return (
                      <td
                        key={column}
                        rowSpan={span?.rows}
                        colSpan={span?.columns}
                        className={cn(
                          "bg-background max-w-80 truncate border px-2 py-0.5 whitespace-pre",
                          cell?.bold && "font-semibold",
                          cell?.italic && "italic",
                          cell?.align === "center" && "text-center",
                          cell?.align === "right" && "text-right",
                          !cell?.align && /^[-\d.,%$€£ ]+$/.test(cell?.text ?? "") && "text-right",
                        )}
                        style={{ color: hex(cell?.color), backgroundColor: hex(cell?.fill) }}
                      >
                        {cell?.text}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {preview
        ? Array.from({ length: preview.charts }, (_, index) => (
            <ChartImage
              key={`${preview.sheet}:${index}`}
              src={`${base}?sheet=${encodeURIComponent(preview.sheet)}&chart=${index}`}
              label={`Chart ${index + 1} on ${preview.sheet}`}
            />
          ))
        : null}
      {preview && (preview.truncated || preview.otherCharts) ? (
        <p className="text-muted-foreground text-xs">
          {[
            preview.truncated ? "Showing the start of this sheet." : null,
            preview.otherCharts
              ? `${preview.otherCharts === 1 ? "A chart isn’t" : `${preview.otherCharts} charts aren’t`} shown here.`
              : null,
          ]
            .filter(Boolean)
            .join(" ")}{" "}
          Download the original for everything.
        </p>
      ) : null}
    </div>
  );
}

/**
 * One chart, drawn by the server as the file declares it; white like the
 * sheet it sits on, in either theme.
 */
function ChartImage({ src, label }: { src: string; label: string }) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  if (state === "error")
    return <FieldError>Could not draw this chart. Download the original to see it.</FieldError>;
  return (
    <div className="bg-paper relative min-h-24 overflow-hidden rounded-xl border">
      <img
        src={src}
        alt={label}
        onLoad={() => setState("ready")}
        onError={() => setState("error")}
        className={cn("block h-auto w-full", state === "ready" ? "opacity-100" : "opacity-0")}
      />
      {state === "loading" ? (
        <Spinner
          aria-label="Loading chart"
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
        />
      ) : null}
    </div>
  );
}
