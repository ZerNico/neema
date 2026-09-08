export interface SlashToken {
  start: number;
  end: number;
  query: string;
}
export function matchSkillSlash(value: string, start: number, end: number): SlashToken | null {
  if (
    start !== end ||
    start < 0 ||
    start > value.length ||
    (start < value.length && !/\s/u.test(value[start]!))
  )
    return null;
  const match = value.slice(0, start).match(/(?:^|\s)\/([\p{L}\p{N}_-]{0,64})$/u);
  if (!match) return null;
  return { start: start - match[1]!.length - 1, end: start, query: match[1]! };
}
