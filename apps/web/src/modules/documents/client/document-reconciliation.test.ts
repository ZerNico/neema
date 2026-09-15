import { describe, expect, it } from "vitest";
import type { ConversationDocument } from "../schema.ts";
import { reconcileDocument } from "./document-reconciliation.ts";

const document = (overrides: Partial<ConversationDocument> = {}): ConversationDocument => ({
  id: "document-1",
  conversationId: "conversation",
  title: "Draft",
  content: "Original",
  revision: 1,
  lastEditedBy: "model",
  createdAt: "now",
  updatedAt: "now",
  ...overrides,
});

describe("document reconciliation", () => {
  it("adopts a newer remote value when the editor is clean", () => {
    const previous = document();
    const incoming = document({ revision: 2, content: "Remote" });
    expect(reconcileDocument(previous, incoming, previous.content, false)).toEqual({
      document: incoming,
      content: "Remote",
      conflict: false,
    });
  });

  it("keeps dirty source and marks a competing whole-document edit", () => {
    const previous = document();
    const incoming = document({ revision: 2, content: "Remote" });
    expect(reconcileDocument(previous, incoming, "Local", false)).toEqual({
      document: incoming,
      content: "Local",
      conflict: true,
    });
  });

  it("keeps later keystrokes through acknowledgement of an in-flight save", () => {
    const previous = document();
    const incoming = document({ revision: 2, content: "Sent", lastEditedBy: "user" });
    expect(reconcileDocument(previous, incoming, "Typed later", false, "Sent")).toEqual({
      document: incoming,
      content: "Typed later",
      conflict: false,
    });
  });

  it("ignores stale revisions and accepts title-only revision changes", () => {
    const current = document({ revision: 3, content: "Current" });
    expect(reconcileDocument(current, document({ revision: 2 }), "Local", true)).toEqual({
      document: current,
      content: "Local",
      conflict: true,
    });
    const renamed = document({ revision: 4, content: "Current", title: "Renamed" });
    expect(reconcileDocument(current, renamed, "Local", false)).toEqual({
      document: renamed,
      content: "Local",
      conflict: false,
    });
  });
});
