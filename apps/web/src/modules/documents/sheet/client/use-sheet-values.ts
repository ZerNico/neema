import { useEffect, useMemo, useRef, useState } from "react";
import type { CalcContext, SheetValues } from "@chat/sheet/model/calc";
import { positions, type SheetDoc } from "@chat/sheet/model";
import { calculateForWire, valuesOf, type CalcPost, type CalcResult } from "./calc-protocol.ts";

/**
 * How much a sheet may hold and still be calculated in place as it opens, before its worker
 * has started: about a frame's work. Measured, a formula costs some 7µs and each cell its
 * references cover some 0.2µs more, so a thousand lookups over a thousand rows take 375ms.
 */
const FIRST_IN_PLACE = { formulas: 1_000, reads: 50_000 };

type Positions = ReturnType<typeof positions>;

/** How many rows or columns a reference spans: the axis's whole length for a whole row or column. */
const span = (axis: Positions, from: string | null, to: string | null) =>
  from === null || to === null
    ? axis.ids.length
    : Math.abs((axis.at(to) ?? 0) - (axis.at(from) ?? 0)) + 1;

/** Whether a document's formulas are few and read little enough to calculate at once. */
const small = (doc: SheetDoc) => {
  let formulas = 0;
  let reads = 0;
  const sizes = new Map<string, { rows: Positions; cols: Positions }>();
  const sized = (id: string) => {
    let known = sizes.get(id);
    const sheet = doc.sheet[id];
    if (!known && sheet) {
      known = { rows: positions(sheet.rows), cols: positions(sheet.cols) };
      sizes.set(id, known);
    }
    return known;
  };
  for (const [id, sheet] of Object.entries(doc.sheet))
    for (const row of Object.values(sheet.cells))
      for (const cell of Object.values(row)) {
        if (!cell.f) continue;
        if (++formulas > FIRST_IN_PLACE.formulas) return false;
        for (const part of cell.f.parts) {
          if (typeof part === "string") continue;
          // A reference across sheets is rare enough to leave to the worker.
          if (part.k === "span") return false;
          const size = sized(part.sheet ?? id);
          if (!size) continue;
          const to = part.to ?? part.from;
          reads += span(size.rows, part.from.row, to.row) * span(size.cols, part.from.col, to.col);
          if (reads > FIRST_IN_PLACE.reads) return false;
        }
      }
  return true;
};

/**
 * A sheet's values, calculated in a worker so typing never waits on a big
 * sheet. Each request carries a generation; an answer for an older one is
 * dropped. Without workers (tests, old browsers) it calculates in place, and
 * so does a small sheet until the worker's first answer, so its formulas show
 * as it opens rather than once the worker has loaded.
 */
export function useSheetValues(
  doc: SheetDoc | null,
  context: CalcContext | null,
): SheetValues | null {
  const worker = useRef<Worker | null>(null);
  const generation = useRef(0);
  const [result, setResult] = useState<CalcResult | null>(null);
  useEffect(() => {
    if (typeof Worker === "undefined") return;
    const created = new Worker(new URL("./calc-worker.ts", import.meta.url), { type: "module" });
    created.addEventListener("message", (event: MessageEvent<CalcResult>) => {
      if (event.data.generation === generation.current) setResult(event.data);
    });
    worker.current = created;
    return () => {
      created.terminate();
      worker.current = null;
    };
  }, []);
  const inline = typeof Worker === "undefined";
  // What the values are calculated for. A new revision's moment and seed change only what
  // NOW, TODAY and RAND return, so while the last result read neither, a new context alone
  // (all a confirmed edit of one's own brings) is not calculated again. A new document is.
  const [target, setTarget] = useState({ doc, context });
  const reads = inline || result === null || result.volatile;
  if (target.doc !== doc || (target.context !== context && (target.context === null || reads)))
    setTarget({ doc, context });
  useEffect(() => {
    if (!target.doc || !target.context || inline) return;
    const request: CalcPost = {
      generation: ++generation.current,
      doc: JSON.stringify(target.doc),
      context: target.context,
    };
    worker.current?.postMessage(request);
  }, [target, inline]);
  return useMemo(() => {
    const { doc: shown, context: at } = target;
    if (!shown || !at) return null;
    if (inline || (result === null && small(shown)))
      return valuesOf(shown, at, calculateForWire({ generation: 0, doc: shown, context: at }));
    return valuesOf(shown, at, result);
  }, [target, inline, result]);
}
