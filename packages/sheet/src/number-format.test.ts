import { describe, expect, it } from "vitest";
import { DE_DE, FR_FR, type SheetLocale } from "./locales.ts";
import { formatValue, generalText } from "./number-format.ts";

/** What Excel (US English) shows for a value in a format code. */
const show = (value: number | string | boolean | null, code: string, locale?: SheetLocale) =>
  formatValue(value, code, locale)?.text;

describe("number formats", () => {
  it("writes digits, grouping, scaling and percent as Excel does", () => {
    expect(show(1234.567, "#,##0.00")).toBe("1,234.57");
    expect(show(0.256, "0.0%")).toBe("25.6%");
    expect(show(0.5, "0%")).toBe("50%");
    expect(show(5, "000")).toBe("005");
    expect(show(1234567, "#,##0,")).toBe("1,235");
    expect(show(1234567, "0.0,,")).toBe("1.2");
    expect(show(0, "#,##0")).toBe("0");
    expect(show(0, "#")).toBe("");
    expect(show(0.5, "#.##")).toBe(".5");
    expect(show(12.5, ".00")).toBe("12.50");
    expect(show(123456789, "000-00-0000")).toBe("123-45-6789");
  });

  it("drops or pads the fraction as #, 0 and ? ask", () => {
    expect(show(1.5, "0.0#")).toBe("1.5");
    expect(show(1.25, "0.0#")).toBe("1.25");
    expect(show(1.5, "0.??")).toBe("1.5 ");
    expect(show(1.5, "0.00")).toBe("1.50");
  });

  it("rounds half away from zero at fifteen significant digits", () => {
    expect(show(1.005, "0.00")).toBe("1.01");
    expect(show(2.5, "0")).toBe("3");
    expect(show(-2.5, "0")).toBe("-3");
    expect(show(-0.4, "0")).toBe("-0");
  });

  it("picks the section for the sign, a condition or text, and its colour", () => {
    expect(show(-1234.5, "$#,##0.00")).toBe("-$1,234.50");
    expect(show(1234.5, "$#,##0.00_);($#,##0.00)")).toBe("$1,234.50 ");
    expect(show(-1234.5, "$#,##0.00_);($#,##0.00)")).toBe("($1,234.50)");
    expect(show(0, '0.00;-0.00;"zero"')).toBe("zero");
    expect(formatValue(-5, "0;[Red]0")).toEqual({ text: "5", color: "red" });
    expect(show(150, '[>100]"big";"small"')).toBe("big");
    expect(show(50, '[>100]"big";"small"')).toBe("small");
    expect(show("abc", "@")).toBe("abc");
    expect(show("abc", '0;0;0;"x"@')).toBe("xabc");
    expect(show("abc", "0.00")).toBe("abc");
    expect(show(true, "0.00")).toBe("TRUE");
    expect(show(null, "0.00")).toBe("");
  });

  it("writes scientific and engineering notation", () => {
    expect(show(12345, "0.00E+00")).toBe("1.23E+04");
    expect(show(0.000123, "0.00E+00")).toBe("1.23E-04");
    expect(show(12345, "##0.0E+0")).toBe("12.3E+3");
    expect(show(0, "0.00E+00")).toBe("0.00E+00");
  });

  it("writes fractions, closest or over a fixed denominator", () => {
    expect(show(1.25, "# ?/?")).toBe("1 1/4");
    expect(show(0.333, "# ?/?")).toBe(" 1/3");
    expect(show(2.5, "?/?")).toBe("5/2");
    expect(show(0.3, "# ?/8")).toBe(" 2/8");
    expect(show(2, "# ?/?")).toBe("2    ");
    expect(show(2.14159, "# ??/??")).toBe("2 14/99");
  });

  it("writes dates and times, minutes beside hours and elapsed time", () => {
    expect(show(45292, "yyyy-mm-dd")).toBe("2024-01-01");
    expect(show(45292, "mmm d, yyyy")).toBe("Jan 1, 2024");
    expect(show(45292, "dddd")).toBe("Monday");
    expect(show(45292, "d-mmm-yy")).toBe("1-Jan-24");
    expect(show(45292, "mmmmm")).toBe("J");
    expect(show(0.5, "h:mm AM/PM")).toBe("12:00 PM");
    expect(show(45292.75, "yyyy-mm-dd hh:mm:ss")).toBe("2024-01-01 18:00:00");
    expect(show(1.5, "[h]:mm")).toBe("36:00");
    expect(show(0.25 + 1.5 / 86_400, "hh:mm:ss.0")).toBe("06:00:01.5");
    expect(show(0.75, "h:mm a/p")).toBe("6:00 p");
    expect(formatValue(-1, "yyyy-mm-dd")).toBeNull();
  });

  it("writes General in about eleven characters", () => {
    expect(generalText(1 / 3)).toBe("0.333333333");
    expect(generalText(-0.5)).toBe("-0.5");
    expect(generalText(1234.5)).toBe("1234.5");
    expect(generalText(123456789012)).toBe("1.23457E+11");
    expect(generalText(0.000001234)).toBe("1.234E-06");
    expect(show(1234.5, "")).toBe("1234.5");
  });

  it("uses the locale's separators and names, never Intl", () => {
    expect(show(1234.5, "#,##0.00", DE_DE)).toBe("1.234,50");
    expect(show(45292, "dd/mm/yyyy", DE_DE)).toBe("01.01.2024");
    expect(show(45292, "mmmm", DE_DE)).toBe("Januar");
    expect(show(45292, "dddd", DE_DE)).toBe("Montag");
    expect(show(1234.5, "#,##0.00", FR_FR)).toBe("1 234,50");
    expect(generalText(0.5, DE_DE)).toBe("0,5");
    expect(show(1234.5, "#,##0.00 [$€-407]", DE_DE)).toBe("1.234,50 €");
  });
});
