import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import {
  decodeSkillText,
  NEW_SKILL_FILES,
  SkillPackageError,
  validateSkillPackage,
  validateSkillPath,
} from "./package.ts";
import {
  exportSkillArchive,
  readSkillArchive,
  selectSkillPackage,
  skillPackageRoots,
} from "./archive.ts";

const root = (yaml: string) => [{ path: "SKILL.md", content: `---\n${yaml}\n---\n\nInstructions` }];
describe("portable skill packages", () => {
  it("parses the raw document as its only metadata source", () => {
    expect(validateSkillPackage(NEW_SKILL_FILES).metadata).toEqual({
      name: "new-skill",
      description: "Describe when to use this skill.",
      manualOnly: false,
    });
    expect(
      validateSkillPackage(
        root("name: manual\ndescription: Manual\ndisable-model-invocation: true"),
      ).metadata.manualOnly,
    ).toBe(true);
  });
  it.each([
    "../escape",
    "/absolute",
    "C:/drive",
    "a\\b",
    "a//b",
    "./a",
    "a/../b",
    "a\u0000b",
    "a./b",
    "e\u0301.md",
  ])("rejects unsafe path %j", (path) =>
    expect(() => validateSkillPath(path)).toThrow(SkillPackageError),
  );
  it.each([
    "name: x\nname: y\ndescription: Test",
    "name: x\ndescription: !execute something",
    "name: x\ndescription: &a [*a]",
    "name: x\ndescription: hi\ndisable-model-invocation: yes",
    "name: Upper\ndescription: text",
    "name: x\ndescription: ''",
  ])("rejects invalid frontmatter %j", (yaml) =>
    expect(() => validateSkillPackage(root(yaml))).toThrow(SkillPackageError),
  );
  it("rejects missing root, duplicate and file/folder collisions", () => {
    expect(() => validateSkillPackage([])).toThrow();
    expect(() =>
      validateSkillPackage([...NEW_SKILL_FILES, { path: "skill.md", content: "duplicate" }]),
    ).toThrow(/colliding/);
    expect(() =>
      validateSkillPackage([
        ...NEW_SKILL_FILES,
        { path: "ref", content: "file" },
        { path: "ref/a.md", content: "child" },
      ]),
    ).toThrow(/parent/);
  });
  it("rejects binary, invalid UTF-8 and malformed Unicode without silently dropping it", () => {
    expect(() => decodeSkillText(new Uint8Array([0xff]), "image.png")).toThrow(/image.png/);
    expect(() => decodeSkillText(new Uint8Array([0]), "nul.txt")).toThrow(/Binary/);
    expect(() =>
      validateSkillPackage([...NEW_SKILL_FILES, { path: "bad.md", content: "\ud800" }]),
    ).toThrow(/surrogate/);
    expect(
      validateSkillPackage([...NEW_SKILL_FILES, { path: "emoji.md", content: "😀" }]).files,
    ).toHaveLength(2);
  });
  it("warns about unsupported directives, and keeps scripts without warning about each", () => {
    const files = [
      ...root("name: script\ndescription: Example\nhooks: {pre: echo nope}\ncontext: fork"),
      { path: "scripts/run.sh", content: "echo not-executed" },
      { path: "scripts/run.py", content: "print('not executed')" },
    ];
    const result = validateSkillPackage(files);
    // The two unsupported directives, and nothing per script file.
    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((finding) => finding.path === "SKILL.md")).toBe(true);
    expect(result.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "scripts/run.py",
      "scripts/run.sh",
    ]);
  });
  it("enforces root and supporting-file byte ceilings", () => {
    expect(() =>
      validateSkillPackage([
        { path: "SKILL.md", content: NEW_SKILL_FILES[0]!.content + "x".repeat(65536) },
      ]),
    ).toThrow(/size/);
    expect(() =>
      validateSkillPackage([...NEW_SKILL_FILES, { path: "large.md", content: "x".repeat(262145) }]),
    ).toThrow(/size/);
  });
});

describe("portable skill archives", () => {
  it("round trips text files without extracting to disk", () => {
    const files = [...NEW_SKILL_FILES, { path: "references/example.md", content: "An example 😀" }];
    expect(readSkillArchive(exportSkillArchive(files))).toEqual(validateSkillPackage(files).files);
  });
  it("requires explicit root selection for multi-package archives", () => {
    const files = ["one/", "two/"].map((prefix) => ({
      ...NEW_SKILL_FILES[0]!,
      path: `${prefix}SKILL.md`,
    }));
    expect(skillPackageRoots(files)).toEqual(["one/", "two/"]);
    expect(selectSkillPackage(files, "two/").files).toEqual(NEW_SKILL_FILES);
    expect(() => selectSkillPackage(files, "")).toThrow(/Select/);
  });
  it("rejects malformed end records even beyond the ZIP comment search window", () => {
    expect(() => readSkillArchive(new Uint8Array(70_000))).toThrow(/end record/);
  });
  it("checks local metadata and actual payload checksums independently", () => {
    const bytes = zipSync(
      { "SKILL.md": new TextEncoder().encode(NEW_SKILL_FILES[0]!.content) },
      { level: 0 },
    );
    const inconsistent = bytes.slice();
    inconsistent[14] = inconsistent[14]! ^ 1;
    expect(() => readSkillArchive(inconsistent)).toThrow(/checksum/);
    const corrupted = bytes.slice();
    const view = new DataView(corrupted.buffer);
    const start = 30 + view.getUint16(26, true) + view.getUint16(28, true);
    corrupted[start] = corrupted[start]! ^ 1;
    expect(() => readSkillArchive(corrupted)).toThrow(/checksum/);
  });
  it("reports every unsupported binary file rather than returning a partial package", () => {
    const bytes = zipSync({
      "first.bin": new Uint8Array([0]),
      "second.bin": new Uint8Array([255]),
    });
    try {
      readSkillArchive(bytes);
      expect.fail("Binary files must reject the package");
    } catch (error) {
      expect(error).toBeInstanceOf(SkillPackageError);
      expect((error as SkillPackageError).findings.map((finding) => finding.path)).toEqual([
        "first.bin",
        "second.bin",
      ]);
    }
  });
  it("rejects traversal before inflating", () => {
    expect(() =>
      readSkillArchive(
        zipSync({ "../SKILL.md": new TextEncoder().encode(NEW_SKILL_FILES[0]!.content) }),
      ),
    ).toThrow(/relative/);
  });
  it("rejects oversized compressed input and expansion bombs", () => {
    expect(() => readSkillArchive(new Uint8Array(5 * 1024 * 1024 + 1))).toThrow(/5 MiB/);
    expect(() => readSkillArchive(zipSync({ "bomb.md": new Uint8Array(262144) }))).toThrow(
      /expansion/,
    );
  });
  it("rejects symlinks and encryption flags", () => {
    const bytes = exportSkillArchive(NEW_SKILL_FILES);
    const patch = (relative: number, value: number, wide = false) => {
      const changed = bytes.slice();
      const view = new DataView(changed.buffer);
      for (let i = 0; i < changed.length - 46; i++)
        if (view.getUint32(i, true) === 0x02014b50) {
          if (wide) view.setUint32(i + relative, value, true);
          else view.setUint16(i + relative, value, true);
          break;
        }
      return changed;
    };
    expect(() => readSkillArchive(patch(38, 0xa1ff0000, true))).toThrow(/links/);
    expect(() => readSkillArchive(patch(8, 1))).toThrow(/Encrypted/);
  });
});
