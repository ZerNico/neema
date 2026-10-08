import { describe, expect, it } from "vitest";
import { formatNumber } from "./format.ts";

const en = (run: () => string) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { language: "en-US" },
    configurable: true,
  });
  try {
    return run();
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
  }
};

describe("formatNumber", () => {
  it("keeps axis labels to their order of magnitude", () => {
    expect(en(() => formatNumber(600_000, "currency:EUR", { axis: true }))).toBe("€600K");
    expect(en(() => formatNumber(600_000, undefined, { axis: true }))).toBe("600K");
    expect(en(() => formatNumber(0.25, "percent", { axis: true }))).toBe("25%");
  });

  it("writes values in full", () => {
    expect(en(() => formatNumber(540_316, "currency:EUR"))).toBe("€540,316.00");
    expect(en(() => formatNumber(600_000, undefined))).toBe("600,000");
    expect(en(() => formatNumber(1.5, "decimal:2"))).toBe("1.50");
  });
});
