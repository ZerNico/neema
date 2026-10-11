import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyChange } from "@chat/sheet/model/apply";
import { parseFormula } from "@chat/sheet/model/formula";
import { emptyDoc, type SheetDoc } from "@chat/sheet/model";
import type { CalcContext } from "@chat/sheet/model/calc";
import { calculateForWire, type CalcPost, type CalcResult } from "./calc-protocol.ts";
import { useSheetValues } from "./use-sheet-values.ts";

/** A worker that calculates as the real one does, answering on the next task. */
const posted: CalcPost[] = [];
class FakeWorker {
  #listener: ((event: MessageEvent<CalcResult>) => void) | null = null;
  addEventListener(_type: string, listener: (event: MessageEvent<CalcResult>) => void) {
    this.#listener = listener;
  }
  postMessage(request: CalcPost) {
    posted.push(request);
    const answer = calculateForWire({ ...request, doc: JSON.parse(request.doc) as SheetDoc });
    queueMicrotask(() => this.#listener?.(new MessageEvent("message", { data: answer })));
  }
  terminate() {}
}

const withFormula = (text: string) => {
  const doc = emptyDoc();
  const parsed = parseFormula(text, { doc, sheet: "s1" });
  if (!("formula" in parsed)) throw new Error("unparsed");
  return applyChange(
    doc,
    {
      clientId: "t",
      seq: 1,
      ops: [{ op: "set", sh: "s1", cells: [{ r: "s1.r1", c: "s1.c1", f: parsed.formula }] }],
    },
    1,
  ).doc;
};
const at = (revision: number, now: number): CalcContext => ({
  revision,
  epoch: 0,
  now,
  seed: revision,
});

afterEach(() => {
  vi.unstubAllGlobals();
  posted.length = 0;
});

describe("a sheet's values", () => {
  it("are not calculated again for a new revision's context unless a formula reads it", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const plain = withFormula("1+1");
    const { result, rerender } = renderHook(({ doc, context }) => useSheetValues(doc, context), {
      initialProps: { doc: plain, context: at(1, 45_000) },
    });
    await act(async () => {});
    expect(result.current?.value("s1", "s1.r1", "s1.c1")).toBe(2);
    const values = result.current;
    rerender({ doc: plain, context: at(2, 45_001) });
    await act(async () => {});
    expect(posted).toHaveLength(1);
    expect(result.current).toBe(values);

    // A sheet reading the moment follows every new one.
    const clock = withFormula("NOW()");
    rerender({ doc: clock, context: at(2, 45_001) });
    await act(async () => {});
    expect(result.current?.value("s1", "s1.r1", "s1.c1")).toBe(45_001);
    rerender({ doc: clock, context: at(3, 45_002) });
    await act(async () => {});
    expect(result.current?.value("s1", "s1.r1", "s1.c1")).toBe(45_002);
    expect(posted).toHaveLength(3);
  });
});
