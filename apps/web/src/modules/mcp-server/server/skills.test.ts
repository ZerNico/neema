import { describe, expect, it } from "vitest";
import type { SkillSummary } from "~/modules/skills/schema.ts";
import { promptNames } from "./skills.ts";

const skill = (id: string, name: string) => ({ id, name }) as SkillSummary;

describe("promptNames", () => {
  it("names each skill after itself while no other skill takes that name", () => {
    expect(promptNames([skill("a", "travel"), skill("b", "review")]).map((p) => p.name)).toEqual([
      "travel",
      "review",
    ]);
  });

  it("never gives two skills one name, whatever they are called", () => {
    const skills = [
      skill("s-1", "travel"),
      skill("s-2", "travel"),
      // Named like another skill's id: the name it would get collides.
      skill("s-3", "s-1"),
    ];
    const names = promptNames(skills).map((p) => p.name);
    expect(new Set(names).size).toBe(skills.length);
    expect(names).toEqual(["s-1", "s-2", "s-3"]);
  });
});
