import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { PARITY_CASES } from "./parity-cases.ts";
import { compareWithExcel, describeCase, sameCase, type ParityCase } from "./parity.ts";

/**
 * Cases where the engine knowingly differs from Excel, by label, with why.
 * A listed case that starts matching fails too, so the list never goes stale.
 */
const KNOWN_DIFFERENCES: Record<string, string> = {};

const fixture = new URL("../../../../../tests/fixtures/excel-parity.xlsx", import.meta.url);

describe("formula engine against Excel", () => {
  // Both tests read the same comparison: recalculating the fixture once is enough.
  let cases: ParityCase[];
  beforeAll(async () => {
    cases = await compareWithExcel(new Uint8Array(readFileSync(fixture)));
  });

  it("computes what Excel computed, for legacy and dynamic formulas alike", () => {
    // Regenerate the fixture (scripts/excel-golden.ts) whenever the cases change.
    expect(cases.filter((item) => item.sheet === "Legacy")).toHaveLength(PARITY_CASES.length);
    expect(cases.filter((item) => item.sheet === "Dynamic")).toHaveLength(PARITY_CASES.length);
    const differing = cases.filter((item) => !sameCase(item));
    const unexpected = differing
      .filter((item) => !(`${item.sheet} ${item.label}` in KNOWN_DIFFERENCES))
      .map((item) => `${item.sheet} ${item.label}: ${describeCase(item)}`);
    const stale = Object.keys(KNOWN_DIFFERENCES).filter(
      (key) => !differing.some((item) => `${item.sheet} ${item.label}` === key),
    );
    expect(unexpected).toEqual([]);
    expect(stale).toEqual([]);
    // Excel kept exactly the dynamic marks we wrote; the engine must still decide the same.
    const marks = cases.filter((item) => item.marked && item.marked.excel !== item.marked.ours);
    expect(
      marks.map((item) => `${item.label}: excel ${item.marked!.excel}, ours ${item.marked!.ours}`),
    ).toEqual([]);
  });

  it("was generated from these cases", () => {
    expect(cases.filter((item) => item.sheet === "Legacy").map((item) => item.label)).toEqual(
      PARITY_CASES.map((item) => `${item.group}: ${item.formula}`),
    );
  });
});
