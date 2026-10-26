import { expect, test } from "vitest";
import { globToRegExp, matchedPrefix } from "./glob.ts";
import { outputCollector } from "./exec.ts";
import { mountKey, place, roots, type Mount } from "./paths.ts";

const mounts: Mount[] = [
  { name: "site", hostPath: "/Users/a/site", readOnly: false },
  { name: "refs", hostPath: "/Users/a/refs", readOnly: true },
];

test("paths inside the workspace or a folder are placed, normalized", () => {
  expect(place("/workspace/a/../b.txt", mounts)).toEqual({
    ok: true,
    path: "/workspace/b.txt",
    root: "/workspace",
    readOnly: false,
  });
  expect(place("/folders/refs/x/", mounts)).toMatchObject({
    ok: true,
    path: "/folders/refs/x",
    readOnly: true,
  });
  expect(place("/folders/site", mounts)).toMatchObject({ ok: true, root: "/folders/site" });
});

test("anything else is outside, and relative paths are named as such", () => {
  expect(place("/etc/passwd", mounts)).toEqual({ ok: false, reason: "outside" });
  expect(place("/workspace/../etc", mounts)).toEqual({ ok: false, reason: "outside" });
  expect(place("/folders/other/x", mounts)).toEqual({ ok: false, reason: "outside" });
  expect(place("/folders/sitex", mounts)).toEqual({ ok: false, reason: "outside" });
  expect(place("workspace/x", mounts)).toEqual({ ok: false, reason: "not-absolute" });
});

test("roots list the workspace first, and the mount key ignores order", () => {
  expect(roots(mounts).map((root) => root.path)).toEqual([
    "/workspace",
    "/folders/site",
    "/folders/refs",
  ]);
  expect(mountKey("/w", mounts)).toBe(mountKey("/w", mounts.toReversed()));
  expect(mountKey("/w", mounts)).not.toBe(mountKey("/w", [{ ...mounts[0]!, readOnly: true }]));
});

test("a glob matches at any depth without a slash, and through a matching folder", () => {
  const ts = globToRegExp("*.ts");
  expect(matchedPrefix(ts, "src/a.ts")).toBe("src/a.ts");
  expect(matchedPrefix(ts, "src/a.js")).toBeUndefined();
  const extracted = globToRegExp("*extracted*");
  expect(matchedPrefix(extracted, "DVR/extracted_images/frame.png")).toBe("DVR/extracted_images");
  expect(matchedPrefix(globToRegExp("src/**/*.test.ts"), "src/a/b.test.ts")).toBe(
    "src/a/b.test.ts",
  );
  expect(matchedPrefix(globToRegExp("{a,b}.md"), "docs/b.md")).toBe("docs/b.md");
  // The rest of an absolute pattern is matched from its root, not at any depth.
  expect(matchedPrefix(globToRegExp("*.md", true), "docs/b.md")).toBeUndefined();
  expect(matchedPrefix(globToRegExp("*.md", true), "b.md")).toBe("b.md");
});

test("output keeps its start and end within the limit", () => {
  const collector = outputCollector(400);
  collector.push(Buffer.from("start\n" + "x".repeat(2_000) + "\nend"));
  const { output, truncated } = collector.result();
  expect(truncated).toBe(true);
  expect(output.startsWith("start")).toBe(true);
  expect(output.endsWith("end")).toBe(true);
  expect(output).toMatch(/characters left out/);
  expect(output.length).toBeLessThanOrEqual(420);
  const small = outputCollector(400);
  small.push(Buffer.from([0xe2, 0x82]));
  small.push(Buffer.from([0xac]));
  expect(small.result()).toEqual({ output: "€", truncated: false });
});
