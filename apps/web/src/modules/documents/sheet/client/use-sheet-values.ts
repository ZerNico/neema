import { useEffect, useMemo, useRef, useState } from "react";
import type { CalcContext, SheetValues } from "@chat/sheet/model/calc";
import type { SheetDoc } from "@chat/sheet/model";
import { calculateForWire, valuesOf, type CalcPost, type CalcResult } from "./calc-protocol.ts";

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
    if (inline)
      return valuesOf(shown, at, calculateForWire({ generation: 0, doc: shown, context: at }));
    return valuesOf(shown, at, result);
  }, [target, inline, result]);
}
