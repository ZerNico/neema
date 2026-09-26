import { describe, expect, it } from "vitest";
import { validateCron } from "~/modules/schedules/server/cron.ts";
import {
  AGENT_AUTHORING_SKILL,
  BUILTIN_SKILLS,
  SCHEDULE_AUTHORING_SKILL,
  findBuiltinSkill,
} from "./index.ts";

describe("bundled skills", () => {
  it("exposes the two authoring skills with builtin-prefixed ids", () => {
    expect(BUILTIN_SKILLS.map((skill) => skill.id)).toEqual([
      "builtin:agent-authoring",
      "builtin:schedule-authoring",
    ]);
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.name.length).toBeGreaterThan(0);
      expect(skill.description.length).toBeGreaterThan(0);
      expect(skill.root.startsWith("---\nname: " + skill.name)).toBe(true);
    }
  });

  it("keeps the advertised tool names and the no-save rule in each body", () => {
    expect(AGENT_AUTHORING_SKILL.root).toContain("draft_agent");
    expect(AGENT_AUTHORING_SKILL.root).toContain("update_agent_draft");
    expect(AGENT_AUTHORING_SKILL.root).toContain("list_agent_options");
    expect(AGENT_AUTHORING_SKILL.root).toContain("Never claim an agent was created or saved");
    expect(SCHEDULE_AUTHORING_SKILL.root).toContain("draft_schedule");
    expect(SCHEDULE_AUTHORING_SKILL.root).toContain("update_schedule_draft");
    expect(SCHEDULE_AUTHORING_SKILL.root).toContain("Never claim a schedule 'will run'");
    // The cron recipes the schedule flow leans on.
    expect(SCHEDULE_AUTHORING_SKILL.root).toContain("0 7 * * 1-5");
    expect(SCHEDULE_AUTHORING_SKILL.root).toContain("endAt");
  });

  it("advertises cron recipes accepted by the schedule validator", () => {
    const section = SCHEDULE_AUTHORING_SKILL.root.split("Common recipes,")[1]?.split("\n\n")[0];
    expect(section).toBeDefined();
    const recipes = [...section!.matchAll(/^- [^\n]+: ([^\n]+)$/gm)];
    expect(recipes).toHaveLength(5);
    for (const [, cron] of recipes) {
      expect(validateCron(cron!, "UTC")).toBeNull();
    }
  });

  it("resolves by exact id only", () => {
    expect(findBuiltinSkill("builtin:agent-authoring")).toBe(AGENT_AUTHORING_SKILL);
    expect(findBuiltinSkill("agent-authoring")).toBeUndefined();
    expect(findBuiltinSkill("builtin:unknown")).toBeUndefined();
  });
});
