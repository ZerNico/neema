import type { DocumentPresence } from "./schema.ts";

const CURSOR_COLORS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4"] as const;

/**
 * How a person's cursor is labelled and coloured: their name, and a colour
 * fixed by their ID so it looks the same in every tab. The server sets it on
 * every cursor it relays, so no one can choose another's name or inject CSS.
 */
export const presenceUser = (user: { id: string; name: string }): DocumentPresence["user"] => {
  let hash = 0;
  for (const character of user.id) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  const token = CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length]!;
  return {
    name: user.name,
    color: `var(${token})`,
    colorLight: `color-mix(in oklab, var(${token}) 25%, transparent)`,
  };
};
