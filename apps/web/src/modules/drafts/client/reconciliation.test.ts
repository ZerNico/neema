import { describe, expect, it } from "vitest";
import { EMPTY_AGENT_DRAFT, type AgentDraft } from "~/modules/agents/draft-schema.ts";
import { draftChanges, reconcileDraft, type DraftFields } from "./reconciliation.ts";
// Exercised through the agent shape; the reducer itself is kind-agnostic.
const fields = Object.keys(EMPTY_AGENT_DRAFT) as DraftFields<AgentDraft["settings"]>;
const reconcile = (
  ...args: Parameters<typeof reconcileDraft<AgentDraft["settings"]>> extends [unknown, ...infer R]
    ? R
    : never
) => reconcileDraft(fields, ...args);
const draft = (overrides: Partial<AgentDraft> = {}): AgentDraft => ({
  id: "draft-1",
  conversationId: "conversation",
  kind: "agent",
  settings: EMPTY_AGENT_DRAFT,
  revision: 1,
  targetId: null,
  targetRevision: null,
  savedDraftRevision: null,
  createdAt: "now",
  updatedAt: "now",
  ...overrides,
});
describe("draft field reconciliation", () => {
  it("patches only different fields, including explicit array clears", () => {
    expect(
      draftChanges(
        fields,
        { ...EMPTY_AGENT_DRAFT, skillIds: ["skill"] },
        { ...EMPTY_AGENT_DRAFT, name: "New" },
      ),
    ).toEqual({ name: "New", skillIds: [] });
  });
  it("accepts clean fields, keeps conflicting local values, and converges identical array edits", () => {
    const previous = draft();
    const local = { ...EMPTY_AGENT_DRAFT, name: "Mine", collectionIds: ["collection"] };
    const incoming = draft({
      revision: 2,
      settings: {
        ...EMPTY_AGENT_DRAFT,
        name: "Theirs",
        description: "Remote",
        collectionIds: ["collection"],
      },
    });
    const result = reconcile(previous, incoming, local, []);
    expect(result.values).toMatchObject({
      name: "Mine",
      description: "Remote",
      collectionIds: ["collection"],
    });
    expect(result.conflicts).toEqual(["name"]);
    expect(result.reviewChanged).toBe(true);
  });
  it("does not mistake acknowledged text for a conflicting edit made after dispatch", () => {
    const result = reconcile(
      draft(),
      draft({ revision: 2, settings: { ...EMPTY_AGENT_DRAFT, name: "Sent" } }),
      { ...EMPTY_AGENT_DRAFT, name: "Typed after send" },
      [],
      { name: "Sent" },
    );
    expect(result.values.name).toBe("Typed after send");
    expect(result.conflicts).toEqual([]);
    expect(result.reviewChanged).toBe(false);
  });
  it("never regresses a save receipt or a later working revision from stale query results", () => {
    const saved = draft({ targetId: "saved", targetRevision: 1, savedDraftRevision: 1 });
    expect(reconcile(saved, draft(), saved.settings, []).draft).toBe(saved);
    const later = draft({ revision: 3, settings: { ...EMPTY_AGENT_DRAFT, name: "Later" } });
    expect(reconcile(later, saved, later.settings, []).draft).toBe(later);
  });
});
