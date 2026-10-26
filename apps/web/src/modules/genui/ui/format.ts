import { formatLocale } from "~/i18n/formats.ts";

// Numbers in the reader's locale, for <num> and chart axes. A block names a
// format ("decimal:2", "percent", "compact", "currency:EUR"); QuickJS has no
// Intl worth relying on, so formatting happens here on the host.

/**
 * `axis` keeps tick labels short: amounts are compact ("600K €"), since a
 * gridline needs its order of magnitude, not its last digits.
 */
export function formatNumber(
  value: number,
  format: string | undefined,
  options: { readonly axis?: boolean } = {},
): string {
  const locale = formatLocale();
  const [kind = "decimal", arg] = (format ?? "decimal").split(":");
  const compact = options.axis ? ({ notation: "compact" } as const) : {};
  try {
    if (kind === "percent") {
      const digits = arg ? Number(arg) : 0;
      return new Intl.NumberFormat(locale, {
        style: "percent",
        maximumFractionDigits: digits,
      }).format(value);
    }
    if (kind === "compact")
      return new Intl.NumberFormat(locale, { notation: "compact" }).format(value);
    if (kind === "currency" && arg)
      return new Intl.NumberFormat(locale, { style: "currency", currency: arg, ...compact }).format(
        value,
      );
    if (options.axis) return new Intl.NumberFormat(locale, compact).format(value);
    const digits = arg ? Number(arg) : undefined;
    return new Intl.NumberFormat(
      locale,
      digits === undefined ? {} : { minimumFractionDigits: digits, maximumFractionDigits: digits },
    ).format(value);
  } catch {
    return String(value);
  }
}
