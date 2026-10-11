/**
 * The checks every validator of wire data shares. A change arrives from a
 * browser and is applied on the server, so these hold for anything a person
 * can send, not only for what the editor makes.
 */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * An ID for a row, column, sheet, chart, rule or client: letters, digits and
 * `.`, `-`, `_`, `:`. Never a name objects already carry, such as
 * `constructor`, since IDs key plain objects.
 */
export const isId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z0-9][\w.:-]{0,63}$/.test(value) &&
  !(value in Object.prototype);

export const isIdOrNull = (value: unknown) => value === null || isId(value);

export const isBox = (value: unknown) =>
  isRecord(value) && [value.r1, value.r2, value.c1, value.c2].every(isId);

/** Distinct IDs, at most `max`. */
export const isIdList = (value: unknown, max: number): value is readonly string[] =>
  Array.isArray(value) &&
  value.length <= max &&
  value.every(isId) &&
  new Set(value).size === value.length;

/** A finite number within a range. */
export const isNumberIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

export const isColor = (value: unknown): value is string =>
  typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value);
