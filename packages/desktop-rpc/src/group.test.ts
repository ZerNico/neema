import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { DesktopRpcs } from "./group.ts";

const CONVERSATION = "01990f4e-6650-7a33-a768-611e2e4bf4c7";

const decoder = (tag: string) =>
  Schema.decodeUnknownSync(DesktopRpcs.requests.get(tag)!.payloadSchema);

describe("the page's procedures", () => {
  it("are exactly the folder, browser executor, preview and computer settings ones", () => {
    expect([...DesktopRpcs.requests.keys()].toSorted()).toEqual(
      [
        "folderStatus",
        "chooseFolder",
        "detachFolder",
        "executionSession",
        "cancelCall",
        "setWorkState",
        "saveToWorkspace",
        "readFile",
        "readBinary",
        "fileInfo",
        "revealPath",
        "computerStatus",
        "setRemoteControl",
        "setAgentSocket",
      ].toSorted(),
    );
  });

  it("requires callId on saveToWorkspace, the one model operation", () => {
    const decode = decoder("saveToWorkspace");
    const payload = { conversationId: CONVERSATION, fileName: "q3.pdf", base64: "JVBERi0=" };
    expect(() => decode(payload)).toThrow('Missing key\n  at ["callId"]');
    expect(decode({ ...payload, callId: "call" })).toMatchObject({ callId: "call" });
  });

  it.each(["readFile", "readBinary", "fileInfo"])("%s carries no callId", (tag) => {
    // A preview is the reader's: nothing about it is a model call to replay.
    const decoded = decoder(tag)({
      conversationId: CONVERSATION,
      path: "/workspace/a",
      callId: "c",
    });
    expect(Object.keys(decoded as object)).not.toContain("callId");
  });

  it("takes read-only as optional when choosing a folder", () => {
    const decode = decoder("chooseFolder");
    expect(decode({ conversationId: CONVERSATION })).toEqual({ conversationId: CONVERSATION });
    expect(decode({ conversationId: CONVERSATION, readOnly: true })).toMatchObject({
      readOnly: true,
    });
    expect(() => decode({ conversationId: CONVERSATION, readOnly: "yes" })).toThrow(
      'Expected boolean\n  at ["readOnly"]',
    );
  });

  it.each(["../outside", "/tmp/outside", "__draft__", "not-a-uuid"])(
    "rejects unsafe workspace id %s",
    (conversationId) => {
      expect(() => decoder("folderStatus")({ conversationId })).toThrow(
        'Expected a canonical UUIDv7.\n  at ["conversationId"]',
      );
    },
  );
});
