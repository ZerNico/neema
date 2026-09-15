import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unifiedDiff } from "./diff.ts";
import { globMatches, globToRegExp, walkFiles } from "./walk.ts";

describe("globToRegExp", () => {
  const matches = (pattern: string, path: string) => globToRegExp(pattern).test(path);

  it("matches a bare name at any depth, like .gitignore does", () => {
    expect(matches("*.ts", "index.ts")).toBe(true);
    expect(matches("*.ts", "src/deep/index.ts")).toBe(true);
    expect(matches("*.ts", "src/index.tsx")).toBe(false);
  });

  it("anchors a pattern with a slash to the root", () => {
    expect(matches("src/*.ts", "src/index.ts")).toBe(true);
    expect(matches("src/*.ts", "src/deep/index.ts")).toBe(false);
    expect(matches("src/**/*.ts", "src/deep/index.ts")).toBe(true);
    expect(matches("src/**/*.ts", "src/index.ts")).toBe(true);
  });

  it("supports ? and {a,b}", () => {
    expect(matches("file?.md", "file1.md")).toBe(true);
    expect(matches("file?.md", "file12.md")).toBe(false);
    expect(matches("*.{ts,tsx}", "a/b.tsx")).toBe(true);
    expect(matches("*.{ts,tsx}", "a/b.js")).toBe(false);
  });

  it("treats regex metacharacters literally", () => {
    expect(matches("a.b", "axb")).toBe(false);
    expect(matches("(x)", "(x)")).toBe(true);
  });
});

describe("globMatches", () => {
  const matches = (pattern: string, path: string) => globMatches(globToRegExp(pattern), path);

  it("includes files that sit inside a matching folder", () => {
    expect(matches("**/*extracted*", "DVR/extracted_images")).toBe(true);
    expect(matches("**/*extracted*", "DVR/extracted_images/frame.png")).toBe(true);
    expect(matches("**/*extracted*", "DVR/other/frame.png")).toBe(false);
    expect(matches("*.ts", "src/index.ts")).toBe(true);
    expect(matches("*.ts", "src/nested")).toBe(false);
  });
});

describe("walkFiles", () => {
  let root: string;
  let outside: string;

  beforeAll(async () => {
    const base = await mkdtemp(join(tmpdir(), "chat-walk-"));
    root = join(base, "repo");
    outside = join(base, "outside");
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await mkdir(join(root, "node_modules", "dep"), { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(root, ".gitignore"), "node_modules\n*.log\n");
    await writeFile(join(root, "src", ".gitignore"), "generated.ts\n");
    await writeFile(join(root, "src", "index.ts"), "a");
    await writeFile(join(root, "src", "generated.ts"), "b");
    await writeFile(join(root, "src", "nested", "generated.ts"), "c");
    await writeFile(join(root, "src", "nested", "deep.ts"), "d");
    await writeFile(join(root, "debug.log"), "e");
    await writeFile(join(root, "node_modules", "dep", "index.js"), "f");
    await writeFile(join(root, ".git", "HEAD"), "g");
    await writeFile(join(outside, "secret.txt"), "h");
    await symlink(outside, join(root, "link"));
  });

  afterAll(async () => {
    await rm(join(root, ".."), { recursive: true, force: true });
  });

  it("honours nested .gitignore files, skips .git, and never follows a symlink", async () => {
    const { files, truncated } = await walkFiles(root, 1000);
    expect(files.map((file) => file.relative).sort()).toEqual([
      ".gitignore",
      "src/.gitignore",
      "src/index.ts",
      "src/nested/deep.ts",
    ]);
    expect(truncated).toBe(false);
  });

  it("reports truncation when the visit budget runs out", async () => {
    const { files, truncated } = await walkFiles(root, 2);
    expect(files.length).toBeLessThanOrEqual(2);
    expect(truncated).toBe(true);
  });

  it("can name a matching directory as well as the files under it", async () => {
    const matcher = globToRegExp("**/*nested*");
    const { files } = await walkFiles(
      root,
      1000,
      (rel) => globMatches(matcher, rel),
      (rel) => matcher.test(rel),
    );
    const paths = files.map((file) => file.relative).sort();
    expect(paths).toContain("src/nested/");
    expect(paths).toContain("src/nested/deep.ts");
    expect(paths).not.toContain("src/index.ts");
  });
});

describe("unifiedDiff", () => {
  it("shows the change with context and correct hunk ranges", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
    const after = ["a", "b", "c", "d", "X", "f", "g", "h"].join("\n");
    expect(unifiedDiff("f.txt", before, after).diff).toBe(
      [
        "--- a/f.txt",
        "+++ b/f.txt",
        "@@ -2,7 +2,7 @@",
        " b",
        " c",
        " d",
        "-e",
        "+X",
        " f",
        " g",
        " h",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
  });

  it("splits far-apart changes into separate hunks", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const after = lines.map((line) => (line === "l2" || line === "l17" ? `${line}!` : line));
    const { diff } = unifiedDiff("f.txt", lines.join("\n"), after.join("\n"));
    expect(diff.match(/^@@/gm)).toHaveLength(2);
    expect(diff).toContain("-l2\n+l2!");
    expect(diff).toContain("-l17\n+l17!");
  });
});
