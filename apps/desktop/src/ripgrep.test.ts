import { describe, expect, it } from "vitest";
import { LIMITS } from "@chat/desktop-rpc";
import { parseRipgrepSearchOutput } from "./ripgrep.ts";

describe("parseRipgrepSearchOutput", () => {
  it("still reads filesSearched from the summary after the match cap", () => {
    const match = (n: number) =>
      JSON.stringify({
        type: "match",
        data: { path: { text: `f${n}` }, line_number: 1, lines: { text: "x" } },
      });
    const lines = Array.from({ length: LIMITS.matches + 3 }, (_, i) => match(i));
    lines.push(JSON.stringify({ type: "summary", data: { stats: { searches: 12 } } }));
    const parsed = parseRipgrepSearchOutput(lines.join("\n"));
    expect(parsed.matches).toHaveLength(LIMITS.matches);
    expect(parsed.truncated).toBe(true);
    expect(parsed.filesSearched).toBe(12);
  });
});
