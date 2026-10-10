import { useEffect, useMemo, useRef, useState } from "react";
import type { CalcContext, SheetValues } from "@chat/sheet/model/calc";
import type { SheetDoc } from "@chat/sheet/model";
import { calculateForWire, valuesOf, type CalcRequest, type CalcResult } from "./calc-protocol.ts";

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
