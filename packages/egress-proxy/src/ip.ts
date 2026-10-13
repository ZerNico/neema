import { isIP } from "node:net";

export type Words = readonly [number, number, number, number, number, number, number, number];

const isWords = (words: readonly number[]): words is Words => words.length === 8;

export function ipv6Words(address: string): Words | undefined {
  if (isIP(address) !== 6 || address.includes("%")) return;
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const halves = canonical.split("::");
  const left = halves[0] ? halves[0].split(":").map((word) => Number.parseInt(word, 16)) : [];
  const right = halves[1] ? halves[1].split(":").map((word) => Number.parseInt(word, 16)) : [];
  const words =
    halves.length === 1
      ? left
      : [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
  return isWords(words) ? words : undefined;
}

export function dotted(high: number, low: number): string {
  return [high >>> 8, high & 255, low >>> 8, low & 255].join(".");
}

export function carriedIPv4(words: Words): string | undefined {
  const zero = (end: number) => words.slice(0, end).every((word) => word === 0);
  if (
    zero(6) ||
    (zero(5) && words[5] === 0xffff) ||
    (zero(4) && words[4] === 0xffff && words[5] === 0) ||
    (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0))
  ) {
    return dotted(words[6], words[7]);
  }
  if (words[0] === 0x2002) return dotted(words[1], words[2]);
}
