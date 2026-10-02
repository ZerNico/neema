import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { applyToolChunk as applyEncodedToolChunk } from "~/modules/chat/client/use-message-stream.ts";
import { projectAssistantBody } from "~/modules/chat/ui/assistant-body.ts";
import { SkillActivityBlock } from "~/modules/chat/ui/skill-activity-block.tsx";
const applyToolChunk = (tools: Parameters<typeof applyEncodedToolChunk>[0], envelope: unknown) =>
  applyEncodedToolChunk(tools, JSON.stringify(envelope));
const start = {
  v: 1,
  family: "skill",
  phase: "start",
  callId: "call",
  name: "read_skill_file",
  skillId: "skill",
  skillName: "Review",
  path: "references/checklist.md",
  turnIndex: 1,
  callIndex: 0,
  textOffset: 0,
};
describe("summary-only skill activity", () => {
  it("validates the family and excludes unexpected file bodies from live state", () => {
    expect(applyToolChunk([], { ...start, family: undefined })).toEqual([]);
    const tools = applyToolChunk([], { ...start, content: "PRIVATE FILE" });
    expect(tools).toHaveLength(1);
    expect(JSON.stringify(tools)).not.toContain("PRIVATE FILE");
    const complete = applyToolChunk(tools, {
      ...start,
      phase: "result",
      version: 1,
      status: "complete",
      content: "PRIVATE FILE",
    });
    expect(complete[0]?.status).toBe("complete");
    expect(JSON.stringify(complete)).not.toContain("PRIVATE FILE");
    expect(applyToolChunk(complete, start)).toEqual(complete);
  });
  it("groups consecutive skill uses into one plain row, with nothing to open", () => {
    const tools = applyToolChunk([], start);
    const parts = projectAssistantBody({
      content: "",
      streaming: true,
      tools,
      compactions: [],
    }).parts;
    // A run of work, here of one step: the skill row itself.
    const step = parts[0]?.kind === "work" ? parts[0].steps[0] : parts[0];
    expect(step?.kind).toBe("skill");
    if (step?.kind !== "skill") throw new Error("missing skill group");
    render(<SkillActivityBlock activities={step.activities} />);
    expect(screen.getByText("Using Review")).toBeVisible();
    // The row said the skill's name; a disclosure would only repeat it.
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("keeps research skill activity inside its owning run", () => {
    const tools = applyToolChunk([], { ...start, runId: "run" });
    const projection = projectAssistantBody({
      content: "",
      streaming: true,
      tools: [
        ...tools,
        {
          family: "research",
          callId: "run",
          name: "deep_research",
          status: "running",
          progress: { runId: "run" } as never,
        },
      ],
      compactions: [],
    });
    expect(projection.parts.some((part) => part.kind === "skill")).toBe(false);
  });
});
