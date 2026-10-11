import { describe, expect, it } from "vitest";
import { DE_DE, EN_GB, FR_FR } from "./locales.ts";
import { formatValue } from "./number-format.ts";
import { parseTyped } from "./value-parse.ts";

describe("typed entries", () => {
  it("reads numbers, grouping and decimals in US English", () => {
    expect(parseTyped("42")).toEqual({ kind: "number", value: 42 });
    expect(parseTyped("-1.5")).toEqual({ kind: "number", value: -1.5 });
    expect(parseTyped("1,234.50")).toEqual({ kind: "number", value: 1234.5, format: "#,##0.00" });
    expect(parseTyped("1e3")).toEqual({ kind: "number", value: 1000 });
    expect(parseTyped("(12)")).toEqual({ kind: "number", value: -12 });
    expect(parseTyped("1,23")).toEqual({ kind: "text", value: "1,23" });
  });

  it("reads percent and currency as a number with the format it implies", () => {
    expect(parseTyped("15%")).toEqual({ kind: "number", value: 0.15, format: "0%" });
    expect(parseTyped("12.5%")).toEqual({ kind: "number", value: 0.125, format: "0.00%" });
    expect(parseTyped("1,234.567")).toEqual({
      kind: "number",
      value: 1234.567,
      format: "#,##0.00",
    });
    expect(parseTyped("$1,234.5")).toEqual({ kind: "number", value: 1234.5, format: "$#,##0.00" });
    expect(parseTyped("-$5")).toEqual({ kind: "number", value: -5, format: "$#,##0.00" });
  });

  it("reads dates in the locale's order, ISO dates and times", () => {
    expect(parseTyped("1/15/2024")).toEqual({ kind: "number", value: 45306, format: "m/d/yyyy" });
    expect(parseTyped("2024-01-15")).toEqual({ kind: "number", value: 45306, format: "m/d/yyyy" });
    expect(parseTyped("15/01/2024", EN_GB)).toEqual({
      kind: "number",
      value: 45306,
      format: "dd/mm/yyyy",
    });
    expect(parseTyped("2/30/2024")).toEqual({ kind: "text", value: "2/30/2024" });
    expect(parseTyped("14:30")).toEqual({ kind: "number", value: 14.5 / 24, format: "h:mm" });
    expect(parseTyped("2:30 PM")).toEqual({
      kind: "number",
      value: 14.5 / 24,
      format: "h:mm AM/PM",
    });
    expect(parseTyped("1/15/2024 6:00")).toEqual({
      kind: "number",
      value: 45306.25,
      format: "m/d/yyyy h:mm",
    });
  });

  it("reads German and French entries in their own separators and currency", () => {
    expect(parseTyped("1,5", DE_DE)).toEqual({ kind: "number", value: 1.5 });
    expect(parseTyped("1.234,50", DE_DE)).toEqual({
      kind: "number",
      value: 1234.5,
      format: "#,##0.00",
    });
    expect(parseTyped("15.01.2024", DE_DE)).toEqual({
      kind: "number",
      value: 45306,
      format: "dd/mm/yyyy",
    });
    const euros = parseTyped("1.234,5 €", DE_DE);
    expect(euros).toEqual({ kind: "number", value: 1234.5, format: "#,##0.00 [$€-407]" });
    expect(formatValue(1234.5, (euros as { format: string }).format, DE_DE)?.text).toBe(
      "1.234,50 €",
    );
    expect(parseTyped("1 234,5", FR_FR)).toEqual({
      kind: "number",
      value: 1234.5,
      format: "#,##0.00",
    });
  });

  it("keeps logicals and anything else as typed", () => {
    expect(parseTyped("true")).toEqual({ kind: "boolean", value: true });
    expect(parseTyped("  ")).toEqual({ kind: "empty" });
    expect(parseTyped("Q3 plan")).toEqual({ kind: "text", value: "Q3 plan" });
  });
});
