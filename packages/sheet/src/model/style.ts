import { isColor, isNumberIn, isRecord } from "./check.ts";

/**
 * Every property a cell's style may have, and what its value must be. A
 * format change carries a patch of these, each set or removed with null;
 * anything else is refused, so what is stored is always what readers draw.
 */
const flag = (value: unknown) => typeof value === "boolean";
const oneOf =
  (...options: readonly string[]) =>
  (value: unknown) =>
    typeof value === "string" && options.includes(value);
const STYLE: Readonly<Record<string, (value: unknown) => boolean>> = {
  bold: flag,
  italic: flag,
  underline: flag,
  strike: flag,
  wrap: flag,
  borderTop: flag,
  borderBottom: flag,
  borderLeft: flag,
  borderRight: flag,
  // A font's name only: nothing that could end a CSS declaration it is written into.
  fontFamily: (value) => typeof value === "string" && /^[^;{}<>"'\\\n]{1,64}$/.test(value),
  fontSize: (value) => isNumberIn(value, 1, 409),
  fontColor: isColor,
  fill: isColor,
  numberFormat: (value) => typeof value === "string" && value.length > 0 && value.length <= 255,
  horizontal: oneOf("left", "center", "right"),
  vertical: oneOf("top", "center", "bottom"),
  link: (value) =>
    typeof value === "string" && value.length <= 2_079 && /^(https?:\/\/|mailto:)/i.test(value),
};

/** Whether a format patch names only style properties, each with a value it may have or null. */
export const isStylePatch = (value: unknown) =>
  isRecord(value) &&
  Object.entries(value).every(
    ([key, each]) => Object.hasOwn(STYLE, key) && (each === null || STYLE[key]!(each)),
  );
