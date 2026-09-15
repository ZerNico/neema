import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { LIMITS } from "@chat/desktop-rpc";
import {
  findWithRipgrep,
  parseRipgrepSearchOutput,
  ripgrepAvailable,
  searchWithRipgrep,
} from "./ripgrep.ts";

describe("parseRipgrepSearchOutput", () => {
  const match = (n: number) =>
    JSON.stringify({
      type: "match",
      data: { path: { text: `f${n}` }, line_number: 1, lines: { text: "x" } },
    });

  it("still reads filesSearched from the summary after the match cap", () => {
    const lines = Array.from({ length: LIMITS.matches + 3 }, (_, i) => match(i));
    lines.push(JSON.stringify({ type: "summary", data: { stats: { searches: 12 } } }));
    const parsed = parseRipgrepSearchOutput(lines.join("\n"));
    expect(parsed.matches).toHaveLength(LIMITS.matches);
    expect(parsed.truncated).toBe(true);
    expect(parsed.filesSearched).toBe(12);
  });

  it("reports output cut before the summary as truncated, not as a small search", () => {
    const parsed = parseRipgrepSearchOutput([match(1), match(2), '{"type":"ma'].join("\n"));
    expect(parsed.matches).toHaveLength(2);
    expect(parsed.summarised).toBe(false);
    expect(parsed.truncated).toBe(true);
  });
});

describe("ripgrep failures", async () => {
  const installed = await ripgrepAvailable();
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "chat-rg-"));
    await writeFile(join(root, "a.txt"), "needle\n");
    await writeFile(join(root, "locked.txt"), "needle\n");
    await chmod(join(root, "locked.txt"), 0o000);
  });
  afterAll(async () => {
    await chmod(join(root, "locked.txt"), 0o644).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const failureOf = async <A>(effect: Effect.Effect<A, { reason: string }>) => {
    const outcome = await Effect.runPromise(Effect.result(effect));
    return outcome._tag === "Failure" ? outcome.failure.reason : "unexpected success";
  };

  it.skipIf(!installed)("tells a bad pattern from a bad glob from a failed run", async () => {
    expect(await failureOf(searchWithRipgrep(root, "(", undefined))).toBe("bad-pattern");
    expect(await failureOf(searchWithRipgrep(root, "needle", "["))).toBe("bad-pattern");
    expect(await failureOf(findWithRipgrep(root, "["))).toBe("bad-pattern");
  });

  // Root reads everything, so the denial this test depends on never happens there.
  it.skipIf(!installed || userInfo().uid === 0)(
    "answers with what it could read when one file cannot be",
    async () => {
      const hits = await Effect.runPromise(searchWithRipgrep(root, "needle", undefined));
      expect(hits.matches.map((hit) => hit.path)).toEqual(["a.txt"]);
      expect(hits.filesSearched).toBeGreaterThan(0);
    },
  );
});
