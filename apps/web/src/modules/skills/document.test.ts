import { describe, expect, it } from "vitest";
import {
  NEW_SKILL_FILES,
  readSkillDocument,
  toSkillName,
  validateSkillPackage,
  writeSkillDocument,
} from "./package.ts";

const TEMPLATE = NEW_SKILL_FILES[0]!.content;

describe("the simple skill editor's view of SKILL.md", () => {
  it("reads the new-skill template and writes it back unchanged", () => {
    const document = readSkillDocument(TEMPLATE)!;
    expect(document).toEqual({
      name: "new-skill",
      description: "Describe when to use this skill.",
      manualOnly: false,
      body: "# Instructions\n\nDescribe the task and how to approach it.\n",
    });
    expect(writeSkillDocument(TEMPLATE, document)).toBe(TEMPLATE);
  });

  it("keeps other keys and comments while changing the edited fields", () => {
    const content =
      "---\n# kept\nname: old\nlicense: MIT\ndescription: Old.\nmetadata:\n  owner: team\n---\n\nBody\n";
    const next = writeSkillDocument(content, {
      name: "contract-review",
      description: "Use for contracts.",
      manualOnly: true,
      body: "New body\n",
    });
    expect(next).toContain("# kept");
    expect(next).toContain("license: MIT");
    expect(next).toContain("owner: team");
    expect(readSkillDocument(next)).toEqual({
      name: "contract-review",
      description: "Use for contracts.",
      manualOnly: true,
      body: "New body\n",
    });
    expect(validateSkillPackage([{ path: "SKILL.md", content: next }]).metadata.manualOnly).toBe(
      true,
    );
    // Turning it back on removes the key rather than writing false.
    const automatic = writeSkillDocument(next, { ...readSkillDocument(next)!, manualOnly: false });
    expect(automatic).not.toContain("disable-model-invocation");
  });

  it("gives up on a file without readable frontmatter", () => {
    expect(readSkillDocument("# Just text\n")).toBeNull();
    expect(readSkillDocument("---\nname: [unclosed\n---\n")).toBeNull();
    expect(readSkillDocument("---\n- a list\n---\n")).toBeNull();
  });

  it("turns typed words into a valid skill name", () => {
    expect(toSkillName("Contract Review")).toBe("contract-review");
    expect(toSkillName("Café  notes_2026!")).toBe("cafe-notes-2026");
    expect(toSkillName("a -- b")).toBe("a-b");
  });
});
