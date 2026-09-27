import { describe, expect, it } from "vitest";
import { composeFileReferenceAliases } from "./file-reference-aliases.ts";

describe("composeFileReferenceAliases", () => {
  it("records only the actual attachment clones and the source workspace", () => {
    expect(
      composeFileReferenceAliases({
        sourceConversationId: "source",
        inherited: null,
        attachmentIds: new Map([
          ["upload", "cloned-upload"],
          ["generated", "cloned-generated"],
        ]),
      }),
    ).toEqual({
      attachments: { upload: "cloned-upload", generated: "cloned-generated" },
      workspaceAncestors: ["source"],
    });
  });

  it("flattens earlier aliases through the copied prefix, dropping missing targets", () => {
    const inherited = {
      attachments: { original: "first", later: "outside-prefix", stale: "deleted" },
      workspaceAncestors: ["original-chat"],
    };
    expect(
      composeFileReferenceAliases({
        sourceConversationId: "first-chat",
        inherited,
        attachmentIds: new Map([["first", "second"]]),
      }),
    ).toEqual({
      attachments: { original: "second", first: "second" },
      workspaceAncestors: ["first-chat", "original-chat"],
    });
    expect(inherited.attachments.original).toBe("first");
  });

  it("keeps deduplicated workspace ancestry even when no attachment was cloned", () => {
    expect(
      composeFileReferenceAliases({
        sourceConversationId: "source",
        inherited: {
          attachments: { stale: "missing" },
          workspaceAncestors: ["ancestor", "source", "ancestor"],
        },
        attachmentIds: new Map(),
      }),
    ).toEqual({ attachments: {}, workspaceAncestors: ["source", "ancestor"] });
  });

  it("rejects conflicting direct and inherited aliases", () => {
    expect(() =>
      composeFileReferenceAliases({
        sourceConversationId: "source",
        inherited: { attachments: { historical: "current" }, workspaceAncestors: [] },
        attachmentIds: new Map([
          ["historical", "one"],
          ["current", "two"],
        ]),
      }),
    ).toThrow("Inconsistent file reference alias collision");
  });

  it("allows identical direct and inherited aliases", () => {
    expect(
      composeFileReferenceAliases({
        sourceConversationId: "source",
        inherited: { attachments: { current: "current" }, workspaceAncestors: [] },
        attachmentIds: new Map([["current", "clone"]]),
      }).attachments,
    ).toEqual({ current: "clone" });
  });

  it("treats object prototype names as literal identifiers", () => {
    const first = composeFileReferenceAliases({
      sourceConversationId: "source",
      inherited: null,
      attachmentIds: new Map([["__proto__", "first"]]),
    });
    const second = composeFileReferenceAliases({
      sourceConversationId: "branch",
      inherited: first,
      attachmentIds: new Map([["first", "second"]]),
    });
    expect(Object.entries(second.attachments)).toEqual([
      ["first", "second"],
      ["__proto__", "second"],
    ]);
  });
});
