import { useEffect, useMemo, useRef, useState } from "react";
import type { Scalar } from "@chat/sheet/engine/values";
import type { CalcContext, SheetValues } from "@chat/sheet/model/calc";
import type { SheetDoc } from "@chat/sheet/model";
import {
  calculateForWire,
  cellKey,
  fromWire,
  type CalcRequest,
  type CalcResult,
} from "./calc-protocol.ts";

const EMPTY_REPORT = { formulas: 0, errors: [], errorCount: 0, unsupported: [] };

/** Values as the page reads them: a typed value at once, a formula's once calculated. */
function valuesOf(doc: SheetDoc, context: CalcContext, result: CalcResult | null): SheetValues {
  const results = new Map<string, Scalar>(
    (result?.results ?? []).map(([key, value]) => [key, fromWire(value)]),
  );
  const spills = new Map(
    (result?.spills ?? []).map(([key, rows, cols]) => [key, { rows: [...rows], cols: [...cols] }]),
  );
  return {
    context,
    report: EMPTY_REPORT,
    value: (sheet, r, c) => {
      const cell = doc.sheet[sheet]?.cells[r]?.[c];
      // What someone typed shows straight away; a formula keeps its last result until the new one.
      if (cell && !cell.f && cell.v !== undefined) return cell.v;
      return results.get(cellKey(sheet, r, c)) ?? null;
    },
    spill: (sheet, r, c) => spills.get(cellKey(sheet, r, c)) ?? null,
  };
}

/**
 * A sheet's values, calculated in a worker so typing never waits on a big
 * sheet. Each request carries a generation; an answer for an older one is
 * dropped. Without workers (tests, old browsers) it calculates in place.
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
  useEffect(() => {
    if (!doc || !context || inline) return;
    const request: CalcRequest = { generation: ++generation.current, doc, context };
    worker.current?.postMessage(request);
  }, [doc, context, inline]);
  return useMemo(() => {
    if (!doc || !context) return null;
    if (inline) return valuesOf(doc, context, calculateForWire({ generation: 0, doc, context }));
    return valuesOf(doc, context, result);
  }, [doc, context, inline, result]);
}
