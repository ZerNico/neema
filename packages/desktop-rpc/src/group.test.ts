import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { DesktopRpcs } from "./group.ts";

const CONVERSATION = "01990f4e-6650-7a33-a768-611e2e4bf4c7";
const BRANCH = "01990f4e-6650-7a33-a768-611e2e4bf4c8";
const SUBMISSION = "550e8400-e29b-41d4-a716-446655440000";
const RESERVATION = "550e8400-e29b-41d4-a716-446655440001";
const path = { conversationId: CONVERSATION, path: "work/file" };
const cases = [
  { tag: "listDirectory", payload: path },
  { tag: "readFile", payload: path },
  { tag: "readBinary", payload: { ...path, purpose: "view" } },
  { tag: "writeFile", payload: { ...path, text: "hello" } },
  {
    tag: "saveToWorkspace",
    payload: { conversationId: CONVERSATION, fileName: "q3.pdf", base64: "JVBERi0=" },
  },
  { tag: "editFile", payload: { ...path, old: "hello", new: "world", all: false } },
  { tag: "movePath", payload: { conversationId: CONVERSATION, from: "work/a", to: "work/b" } },
  { tag: "deletePath", payload: { conversationId: CONVERSATION, paths: ["work/file"] } },
  { tag: "findFiles", payload: { conversationId: CONVERSATION, pattern: "*.ts" } },
  { tag: "searchFiles", payload: { conversationId: CONVERSATION, pattern: "needle" } },
];

describe("model operation identity", () => {
  it.each(cases)("requires callId on $tag", ({ tag, payload }) => {
    const rpc = DesktopRpcs.requests.get(tag)!;
    const decode = Schema.decodeUnknownSync(rpc.payloadSchema);
    expect(() => decode(payload)).toThrow();
    expect(decode({ ...payload, callId: "call" })).toMatchObject({ callId: "call" });
  });

  it("still requires callId for commands", () => {
    const rpc = DesktopRpcs.requests.get("runCommand")!;
    const decode = Schema.decodeUnknownSync(rpc.payloadSchema);
    const payload = {
      conversationId: CONVERSATION,
      command: "true",
      timeoutMs: 100,
    };
    expect(() => decode(payload)).toThrow();
    expect(decode({ ...payload, callId: "call" })).toMatchObject({ callId: "call" });
  });
});

describe("user-driven workspace operations", () => {
  const tags = [
    {
      tag: "stageFile",
      payload: {
        conversationId: CONVERSATION,
        submissionId: SUBMISSION,
        fileName: "a.bin",
        base64: "AA==",
      },
    },
    {
      tag: "discardStagedFile",
      payload: {
        conversationId: CONVERSATION,
        submissionId: SUBMISSION,
        name: "a.bin",
      },
    },
    {
      tag: "discardSubmission",
      payload: { conversationId: CONVERSATION, submissionId: SUBMISSION },
    },
    {
      tag: "promoteSubmission",
      payload: {
        conversationId: CONVERSATION,
        submissionId: SUBMISSION,
        reservationId: RESERVATION,
      },
    },
    {
      tag: "commitPromotion",
      payload: { conversationId: CONVERSATION, reservationId: RESERVATION },
    },
    {
      tag: "rollbackPromotion",
      payload: { conversationId: CONVERSATION, reservationId: RESERVATION },
    },
    {
      tag: "cloneWorkspace",
      payload: { fromConversationId: CONVERSATION, toConversationId: BRANCH },
    },
    {
      tag: "copyFolderGrants",
      payload: { fromConversationId: CONVERSATION, toConversationId: BRANCH },
    },
    { tag: "discardWorkspace", payload: { conversationId: CONVERSATION } },
  ];

  it.each(tags)("$tag carries no callId", ({ tag, payload }) => {
    const rpc = DesktopRpcs.requests.get(tag)!;
    const decode = Schema.decodeUnknownSync(rpc.payloadSchema);
    // A callId would mean the model could fire a user action on its own.
    expect(Object.keys(decode(payload) as object)).not.toContain("callId");
  });

  it.each(["../outside", "/tmp/outside", "__draft__", "not-a-uuid", SUBMISSION])(
    "rejects unsafe workspace id %s",
    (conversationId) => {
      const rpc = DesktopRpcs.requests.get("folderStatus")!;
      const decode = Schema.decodeUnknownSync(rpc.payloadSchema);
      expect(() => decode({ conversationId })).toThrow();
    },
  );
});
