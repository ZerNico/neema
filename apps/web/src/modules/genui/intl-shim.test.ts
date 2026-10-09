import variant from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from "quickjs-emscripten-core";
import { beforeAll, describe, expect, it } from "vitest";
import { compileUi } from "./compile.ts";
import { BlockRuntime } from "./runtime.ts";

let quickjs: QuickJSWASMModule;
beforeAll(async () => {
  quickjs = await newQuickJSWASMModuleFromVariant(variant);
});

// 2026-10-08 13:05 UTC, a Thursday.
const NOW = Date.UTC(2026, 9, 8, 13, 5);

/** What one expression shows inside a real block. */
function shown(expression: string): string {
  const compiled = compileUi(`<text>{${expression}}</text>`);
  if (!compiled.ok) throw new Error("compile failed");
  const booted = BlockRuntime.boot(quickjs, compiled.block, null, NOW);
  if (!booted.ok) throw new Error(booted.error);
  const out = booted.runtime.render();
  booted.runtime.dispose();
  if (!out.ok) throw new Error(out.error);
  return JSON.stringify(out.nodes).replace(/^.*"children":\["?|"?\]\}\]$/g, "");
}

describe("locale formatting inside QuickJS", () => {
  it("formats numbers the way models write them", () => {
    expect(shown(`(1234567.891).toLocaleString("en-US")`)).toBe("1,234,567.891");
    expect(shown(`(1234567.891).toLocaleString("de-DE", { maximumFractionDigits: 2 })`)).toBe(
      "1.234.567,89",
    );
    expect(shown(`(0.256).toLocaleString("en", { style: "percent" })`)).toBe("26%");
    expect(shown(`(1500000).toLocaleString("en", { notation: "compact" })`)).toBe("1.5M");
  });

  it("formats currencies with the locale's symbol placement", () => {
    expect(
      shown(
        `(3000).toLocaleString("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 })`,
      ),
    ).toBe("3.000\u00a0€");
    expect(
      shown(`new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(-42.5)`),
    ).toBe("-$42.50");
    expect(shown(`(1200).toLocaleString("ja-JP", { style: "currency", currency: "JPY" })`)).toBe(
      "¥1,200",
    );
  });

  it("formats dates in UTC for every reader", () => {
    expect(shown(`new Date().toLocaleDateString("en-US")`)).toBe("10/8/2026");
    expect(
      shown(
        `new Date().toLocaleDateString("de-DE", { day: "numeric", month: "long", year: "numeric" })`,
      ),
    ).toBe("8. Oktober 2026");
    expect(shown(`new Date().toLocaleTimeString("en-US")`)).toBe("1:05 PM");
    expect(
      shown(`new Intl.DateTimeFormat("de-DE", { dateStyle: "full" }).format(new Date())`),
    ).toBe("Donnerstag, 8. Oktober 2026");
  });

  it("degrades unknown locales and options to plain formatting, never blank", () => {
    expect(shown(`(1234.5).toLocaleString("xx-YY")`)).toBe("1,234.5");
    expect(
      shown(`(1234.5).toLocaleString(undefined, { style: "currency", currency: "ZZZ" })`),
    ).toBe("ZZZ1,234.50");
  });
});
