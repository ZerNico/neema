import { strFromU8 } from "fflate";
import { resolveIndexedColor, type Color } from "@office-kit/xlsx/styles";
import type { Workbook } from "@office-kit/xlsx/workbook";
import { OFFICE_THEME_XML } from "./office-theme.ts";

/** A theme's colour slots in the order cells number them: Excel swaps the first two pairs. */
const SLOTS = [
  "lt1",
  "dk1",
  "lt2",
  "dk2",
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
  "hlink",
  "folHlink",
];

/** A theme's palette by slot, as RRGGBB; a system colour reads as the colour it was saved with. */
function palette(xml: string) {
  const scheme = /<a:clrScheme\b[\s\S]*?<\/a:clrScheme>/.exec(xml)?.[0] ?? "";
  return SLOTS.map((slot) => {
    const body = new RegExp(`<a:${slot}>([\\s\\S]*?)</a:${slot}>`).exec(scheme)?.[1] ?? "";
    return (
      /<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/.exec(body)?.[1] ??
      /<a:sysClr\b[^>]*\blastClr="([0-9A-Fa-f]{6})"/.exec(body)?.[1] ??
      null
    );
  });
}

/** Excel's tint: towards black below zero, towards white above, on the colour's lightness. */
function tinted(hex: string, tint: number) {
  const [r, g, b] = [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let lightness = (max + min) / 2;
  const delta = max - min;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  // In sixths of the colour wheel, 0 to 6.
  let hue = 0;
  if (delta !== 0)
    hue =
      max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  lightness = tint < 0 ? lightness * (1 + tint) : lightness * (1 - tint) + tint;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs((hue % 2) - 1));
  const sector = Math.min(5, Math.floor(hue));
  const [red, green, blue] = (
    [
      [chroma, x, 0],
      [x, chroma, 0],
      [0, chroma, x],
      [0, x, chroma],
      [x, 0, chroma],
      [chroma, 0, x],
    ] as const
  )[sector]!;
  const offset = lightness - chroma / 2;
  return [red, green, blue]
    .map((part) =>
      Math.round((part + offset) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")
    .toUpperCase();
}

/**
 * How a workbook's colours read as `#RRGGBB`: explicit, from the legacy
 * palette, or from its theme, each with its tint. Null for automatic and
 * unset colours, which take the reader's default.
 */
export function fileColors(workbook: Workbook) {
  const theme = palette(workbook.themeXml ? strFromU8(workbook.themeXml) : OFFICE_THEME_XML);
  return (color: Color | undefined): string | null => {
    if (!color || color.auto) return null;
    const base =
      color.rgb && /^[0-9A-F]{8}$/i.test(color.rgb)
        ? color.rgb.slice(2)
        : color.indexed !== undefined
          ? resolveIndexedColor(color.indexed)?.slice(2)
          : color.theme !== undefined
            ? theme[color.theme]
            : undefined;
    if (!base) return null;
    return `#${color.tint ? tinted(base, color.tint) : base.toUpperCase()}`;
  };
}
