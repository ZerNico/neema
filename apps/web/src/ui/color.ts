/** Colour conversions for the colour picker: hex codes as a sheet keeps them, and HSV. */

export const clamp = (value: number) => Math.min(1, Math.max(0, value));
const HEX = /^#?([0-9a-f]{6})$/i;

/** A colour as hue (0 to 360), saturation and value (0 to 1). */
export interface Hsv {
  readonly h: number;
  readonly s: number;
  readonly v: number;
}


/** `#RRGGBB` as HSV; null for anything else. */
export function hexToHsv(hex: string): Hsv | null {
  const match = HEX.exec(hex.trim());
  if (!match) return null;
  const n = Number.parseInt(match[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((each) => each / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  const h = !delta
    ? 0
    : max === r
      ? ((g - b) / delta + 6) % 6
      : max === g
        ? (b - r) / delta + 2
        : (r - g) / delta + 4;
  return { h: h * 60, s: max ? delta / max : 0, v: max };
}

/** HSV as `#RRGGBB`, upper case as the sheet keeps colours. */
export function hsvToHex({ h, s, v }: Hsv): string {
  const channel = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  return `#${[channel(5), channel(3), channel(1)]
    .map((each) => each.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}
