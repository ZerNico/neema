import { describe, expect, it } from "vitest";
import { composeFileReferenceAliases } from "./file-reference-aliases.ts";

describe("composeFileReferenceAliases", () => {
  it("records only the actual attachment clones", () => {
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
    });
  });

  it("flattens earlier aliases through the copied prefix, dropping missing targets", () => {
    const inherited = {
      attachments: { original: "first", later: "outside-prefix", stale: "deleted" },
    };
    expect(
      composeFileReferenceAliases({
        sourceConversationId: "first-chat",
        inherited,
        attachmentIds: new Map([["first", "second"]]),
      }),
    ).toEqual({
      attachments: { original: "second", first: "second" },
    });
    expect(inherited.attachments.original).toBe("first");
  });

  it("keeps nothing when no attachment was cloned", () => {
    expect(
      composeFileReferenceAliases({
        sourceConversationId: "source",
        inherited: {
          attachments: { stale: "missing" },
        },
        attachmentIds: new Map(),
      }),
    ).toEqual({ attachments: {} });
  });

  it("rejects conflicting direct and inherited aliases", () => {
    expect(() =>
      composeFileReferenceAliases({
        sourceConversationId: "source",
        inherited: { attachments: { historical: "current" } },
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
        inherited: { attachments: { current: "current" } },
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
