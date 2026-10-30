import { describe, expect, it } from "vitest";
import { agentAuthoringRequest } from "~/modules/agents/authoring.ts";
import { scheduleAuthoringRequest } from "~/modules/schedules/authoring.ts";
import { extractReferences, referenceLabel, restoreReferences } from "./references.ts";

describe("message references", () => {
  it("shows an edit request as plain words and sends it unchanged", () => {
    const request = scheduleAuthoringRequest("01a0cb5d-c883-7a2e-94fc-a20a7ce568f2");
    const { text, references } = extractReferences(request);
    expect(text.startsWith("Help me change this schedule. Ask")).toBe(true);
    expect(references).toEqual([
      { kind: "schedule", id: "01a0cb5d-c883-7a2e-94fc-a20a7ce568f2", label: "this schedule" },
    ]);
    expect(restoreReferences(text, references)).toBe(request);
    const agent = agentAuthoringRequest("a1");
    const extracted = extractReferences(agent);
    expect(restoreReferences(extracted.text, extracted.references)).toBe(agent);
  });

  it("keeps the reference when its words were edited away", () => {
    const [reference] = extractReferences("Fix [this agent](/agents/a1).").references;
    expect(restoreReferences("Make it shorter", [reference!])).toBe(
      "[this agent](/agents/a1) Make it shorter",
    );
  });

  it("reads a named document back, with words a link can carry", () => {
    const label = referenceLabel("Plan [draft]\nv2");
    expect(label).toBe("Plan draft v2");
    const content = restoreReferences("Summarise it", [{ kind: "document", id: "d1", label }]);
    expect(content).toBe("[Plan draft v2](/documents/d1) Summarise it");
    expect(extractReferences(content).references).toEqual([
      { kind: "document", id: "d1", label: "Plan draft v2" },
    ]);
    expect(referenceLabel("[]")).toBe("…");
  });

  it("leaves ordinary links and other paths alone", () => {
    const content = "See [docs](https://example.com) and [chat](/chat/c1).";
    expect(extractReferences(content)).toEqual({ text: content, references: [] });
  });
});
