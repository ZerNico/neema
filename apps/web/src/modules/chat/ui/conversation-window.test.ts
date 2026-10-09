import { describe, expect, it } from "vitest";
import { withHistory } from "./conversation-window.ts";

const part = (ids: string[], olderCursor: string | null) => ({
  messages: ids.map((id) => ({ id })),
  toolCalls: ids.map((id) => ({ messageId: id })),
  compactionEvents: [],
  attachments: [],
  generations: [],
  priorSources: [{ index: ids.length }],
  uiStates: ids.map((id) => ({ messageId: id, ordinal: 0 })),
  olderCursor,
});
const head = (ids: string[], olderCursor: string | null) => ({
  ...part(ids, null),
  window: { anchorId: ids[0] ?? null, olderCursor },
});

describe("withHistory", () => {
  it("is the head alone until a page loads", () => {
    const merged = withHistory(head(["c"], "c"), undefined);
    expect(merged.messages.map((m) => m.id)).toEqual(["c"]);
    expect(merged.hasOlder).toBe(true);
  });

  it("lays pages out oldest first above the head", () => {
    // Pages arrive newest first: the one just above the head, then the one before it.
    const merged = withHistory(head(["c"], "c"), [part(["b"], "b"), part(["a"], null)]);
    expect(merged.messages.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(merged.toolCalls.map((call) => call.messageId)).toEqual(["a", "b", "c"]);
    expect(merged.uiStates.map((row) => row.messageId)).toEqual(["a", "b", "c"]);
    expect(merged.priorSources).toHaveLength(3);
    expect(merged.hasOlder).toBe(false);
  });

  it("still has older turns while the last page has a cursor", () => {
    expect(withHistory(head(["c"], "c"), [part(["b"], "b")]).hasOlder).toBe(true);
  });
});
