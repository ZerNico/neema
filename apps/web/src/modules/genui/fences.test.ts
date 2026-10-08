import { describe, expect, it } from "vitest";
import { fenceKey, hashSource, keyUiFences, scanUiFences } from "./fences.ts";

const ANSWER = [
  "Intro",
  "",
  "```ui",
  "<text>one</text>",
  "```",
  "",
  "```js",
  "const x = 1;",
  "```",
  "",
  "````markdown",
  "```ui",
  "<text>example, not a block</text>",
  "```",
  "````",
  "",
  "~~~ui",
  "<text>two</text>",
  "~~~",
].join("\n");

describe("scanUiFences", () => {
  it("finds ui fences in order and ignores ones nested in other fences", () => {
    const fences = scanUiFences(ANSWER);
    expect(fences.map((f) => [f.ordinal, f.code, f.closed])).toEqual([
      [0, "<text>one</text>", true],
      [1, "<text>two</text>", true],
    ]);
  });

  it("reports an open fence with the body streamed so far", () => {
    const fences = scanUiFences("Text\n```ui\n<card>\n  <text>hal");
    expect(fences).toHaveLength(1);
    expect(fences[0]).toMatchObject({ closed: false, code: "<card>\n  <text>hal" });
  });

  it("keeps ordinals stable while content is appended", () => {
    for (let n = 0; n <= ANSWER.length; n++) {
      const prefix = scanUiFences(ANSWER.slice(0, n));
      const full = scanUiFences(ANSWER);
      for (const fence of prefix) {
        expect(fence.start).toBe(full[fence.ordinal]!.start);
      }
    }
  });

  it("needs a closing fence at least as long as the opener", () => {
    expect(scanUiFences("````ui\n<b>x</b>\n```\nstill inside\n````")[0]!.code).toBe("<b>x</b>\n```\nstill inside");
  });
});

describe("keyUiFences", () => {
  it("writes message-wide keys into the openers and nothing else", () => {
    const part = "a\n```ui\n<b>x</b>\n```\nb\n```ui extra\n<b>y</b>\n```";
    expect(keyUiFences(part, 3)).toBe("a\n```ui key=3\n<b>x</b>\n```\nb\n```ui key=4\n<b>y</b>\n```");
  });

  it("round-trips through fenceKey", () => {
    expect(fenceKey("key=2")).toBe(2);
    expect(fenceKey("x key=7 y")).toBe(7);
    expect(fenceKey("key=8")).toBeNull();
    expect(fenceKey(undefined)).toBeNull();
  });
});

describe("hashSource", () => {
  it("is stable and sensitive to every character", () => {
    expect(hashSource("<b>x</b>")).toBe(hashSource("<b>x</b>"));
    expect(hashSource("<b>x</b>")).not.toBe(hashSource("<b>y</b>"));
    expect(hashSource("")).toMatch(/^[0-9a-f]{16}$/);
  });
});
