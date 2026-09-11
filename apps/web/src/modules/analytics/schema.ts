import { Schema } from "effect";

/**
 * What the dashboard asks for: a quick preset, or an arbitrary window.
 *
 * Presets stay a closed set of literals rather than an open day count so their
 * query keys remain the small stable values the route loaders prefetch.
 *
 * Custom boundaries are half-open — `from` inclusive, `to` exclusive — and are
 * always UTC midnights. The picker's end date reads as inclusive to the user,
 * so it encodes as the *following* midnight; that keeps the boundary out of
 * end-of-day arithmetic and makes adjacent windows exact.
 */
export const UsageRangeInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["preset"]),
    days: Schema.Literals([7, 30, 90]),
  }),
  Schema.Struct({
    kind: Schema.Literals(["custom"]),
    from: Schema.DateFromString,
    to: Schema.DateFromString,
  }).pipe(
    Schema.check(
      Schema.makeFilter((range) =>
        range.from.getTime() < range.to.getTime() ? undefined : "from must be before to",
      ),
    ),
  ),
]);

/** Decoded (server) form — custom boundaries are Dates. */
export type UsageRange = typeof UsageRangeInput.Type;

/** Encoded (client/wire) form — custom boundaries are ISO strings. */
export type UsageRangeEncoded = typeof UsageRangeInput.Encoded;

export type UsageRangeDays = 7 | 30 | 90;

/** What both dashboards open on, and what the route loaders prefetch. */
export const DEFAULT_USAGE_RANGE: UsageRangeEncoded = { kind: "preset", days: 30 };
