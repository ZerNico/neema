import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { AgentSettings, type AgentDetail } from "./schema.ts";
import {
  AgentDraftPatch,
  DraftSettings,
  EMPTY_AGENT_DRAFT,
  agentDetailToSettings,
} from "./draft-schema.ts";

describe("agent draft settings", () => {
  it("retains blank intermediate names, instructions and starters without making them save-valid", () => {
    const input = { ...EMPTY_AGENT_DRAFT, starters: [""] };
    expect(Schema.decodeUnknownSync(DraftSettings)(input)).toEqual(input);
    expect(Schema.is(AgentSettings)(input)).toBe(false);
    const complete = { ...input, name: "Agent", instructions: "Help.", starters: ["Begin"] };
    expect(Schema.is(AgentSettings)({ ...complete, instructions: "" })).toBe(false);
    expect(Schema.is(AgentSettings)(complete)).toBe(true);
  });

  it("shares saved-agent field limits and requires complete settings", () => {
    for (const input of [
      { ...EMPTY_AGENT_DRAFT, name: "x".repeat(121) },
      { ...EMPTY_AGENT_DRAFT, description: "x".repeat(501) },
      { ...EMPTY_AGENT_DRAFT, instructions: "x".repeat(20_001) },
      { ...EMPTY_AGENT_DRAFT, starters: ["x".repeat(201)] },
      { ...EMPTY_AGENT_DRAFT, starters: ["", "", "", "", ""] },
      { ...EMPTY_AGENT_DRAFT, skillIds: Array.from({ length: 21 }, (_, i) => String(i)) },
      { ...EMPTY_AGENT_DRAFT, skillIds: undefined },
      { ...EMPTY_AGENT_DRAFT, modelId: "" },
      { name: "Incomplete" },
    ])
      expect(Schema.is(DraftSettings)(input)).toBe(false);
  });

  it("preserves omitted fields, accepts intentional clears, and rejects undefined values", () => {
    const decode = Schema.decodeUnknownSync(AgentDraftPatch);
    expect(decode({ description: "Still typing", collectionIds: [], starters: [""] })).toEqual({
      description: "Still typing",
      collectionIds: [],
      starters: [""],
    });
    expect(decode({})).toEqual({});
    expect(Schema.is(AgentDraftPatch)({ name: undefined })).toBe(false);
    expect(Schema.is(AgentDraftPatch)({ searchEnabled: "true" })).toBe(false);
  });

  it("converts owner details without dropping unavailable saved dependency identities", () => {
    const detail: AgentDetail = {
      id: "agent",
      name: "Writer",
      description: "",
      icon: "pen",
      instructions: "Write clearly",
      audience: "private",
      configRevision: 3,
      canEdit: true,
      ownerName: null,
      updatedAt: "2026-09-10T00:00:00.000Z",
      modelId: "deleted-model",
      model: { id: "deleted-model", name: null, available: false },
      searchEnabled: false,
      planEnabled: true,
      starters: ["Help me write"],
      collections: [{ id: "revoked-collection", name: null, available: false }],
      skills: [{ id: "deleted-skill", name: null, available: false }],
    };
    expect(agentDetailToSettings(detail)).toEqual({
      ...EMPTY_AGENT_DRAFT,
      name: "Writer",
      icon: "pen",
      instructions: "Write clearly",
      planEnabled: true,
      modelId: "deleted-model",
      starters: ["Help me write"],
      collectionIds: ["revoked-collection"],
      skillIds: ["deleted-skill"],
    });
  });
});
