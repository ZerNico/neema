import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useMemo } from "react";
import { sheetLocale } from "@chat/sheet/locales";
import type { SheetDoc } from "@chat/sheet/model";
import type { SheetValues } from "@chat/sheet/model/calc";
import { chartData } from "@chat/sheet/model/chart";
import { documentQuery } from "../../client/document-queries.ts";
import { useSheet } from "../../sheet/client/use-sheet.ts";
import { useSheetValues } from "../../sheet/client/use-sheet-values.ts";
import { embedMoreText, embedTable } from "../../sheet/embed-range.ts";
import type { SheetEmbedHub } from "./sheet-embeds.ts";

// The chart library loads with the first embedded chart, not every embed.
const SheetChart = lazy(() =>
  import("../../sheet/ui/sheet-chart.tsx").then((module) => ({ default: module.SheetChart })),
);

/**
 * One embedded sheet, read live and calculated once for every embed of it.
 * Whether the reader may read it is the server's answer: the document query
 * and the feed both check, so a sheet in someone else's chat is not found.
 */
export function SheetEmbedSource({ hub, sheetId }: { hub: SheetEmbedHub; sheetId: string }) {
  const meta = useQuery(documentQuery(sheetId));
  const readable = meta.data?.kind === "sheet";
  const { state } = useSheet(sheetId, readable, "read");
  const revision = state?.revision ?? 0;
  const moment = state?.moment ?? null;
  const context = useMemo(
    () => (moment ? { revision, epoch: 0, ...moment } : null),
    [revision, moment],
  );
  const doc = state?.doc ?? null;
  const values = useSheetValues(doc, context);
  const unavailable = meta.isError || (meta.isSuccess && !readable) || state?.status === "gone";
  const title = meta.data?.title ?? null;
  useEffect(() => {
    hub.publish(sheetId, {
      status: unavailable ? "unavailable" : doc && values ? "ready" : "loading",
      title,
      doc: unavailable ? null : doc,
      values: unavailable ? null : values,
    });
  }, [hub, sheetId, unavailable, title, doc, values]);
  useEffect(() => () => hub.forget(sheetId), [hub, sheetId]);
  return null;
}

/** What an embed draws once its sheet is in: the range's cells, or the chart. */
export function SheetEmbedBody({
  doc,
  values,
  range,
  chart,
}: {
  doc: SheetDoc;
  values: SheetValues;
  range: string | null;
  chart: string | null;
}) {
  const table = useMemo(
    () => (range ? embedTable(doc, values, range) : null),
    [doc, values, range],
  );
  const spec = chart ? doc.charts[chart] : undefined;
  const data = useMemo(
    () => (spec && doc.sheet[spec.sheet] ? chartData(doc, values, spec) : null),
    [doc, values, spec],
  );
  if (range) {
    if (!table) return <Unavailable>This range isn’t in the sheet any more</Unavailable>;
    const more = embedMoreText(table);
    return (
      <>
        <div className="sheet-embed-table">
          <table>
            <tbody>
              {table.rows.map((row, r) => (
                <tr key={table.rowIds[r]}>
                  {row.map((cell, c) => (
                    <td
                      key={table.colIds[c]}
                      style={{
                        textAlign: cell.align,
                        fontWeight: cell.bold ? 600 : undefined,
                        fontStyle: cell.italic ? "italic" : undefined,
                      }}
                    >
                      {cell.text}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {more ? <p className="text-muted-foreground text-xs">{more}</p> : null}
      </>
    );
  }
  if (!spec || !data || !chart)
    return <Unavailable>This chart isn’t in the sheet any more</Unavailable>;
  return (
    <div className="max-w-full" style={{ width: spec.size.width, height: spec.size.height }}>
      <Suspense fallback={null}>
        <SheetChart id={chart} chart={spec} data={data} locale={sheetLocale(doc.settings.locale)} />
      </Suspense>
    </div>
  );
}

function Unavailable({ children }: { children: string }) {
  return <p className="text-muted-foreground text-sm">{children}</p>;
}
