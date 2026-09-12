import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { DesktopRpcs } from "./group.ts";

const path = { conversationId: "chat", path: "work/file" };
const cases = [
  { tag: "listDirectory", payload: path },
  { tag: "readFile", payload: path },
  { tag: "readBinary", payload: path },
  { tag: "writeFile", payload: { ...path, text: "hello" } },
  { tag: "editFile", payload: { ...path, old: "hello", new: "world", all: false } },
  { tag: "movePath", payload: { conversationId: "chat", from: "work/a", to: "work/b" } },
  { tag: "deletePath", payload: path },
  { tag: "findFiles", payload: { conversationId: "chat", pattern: "*.ts" } },
  { tag: "searchFiles", payload: { conversationId: "chat", pattern: "needle" } },
];

describe("model operation identity", () => {
  it.each(cases)("preserves an optional callId on $tag", ({ tag, payload }) => {
    const rpc = DesktopRpcs.requests.get(tag)!;
    const decode = Schema.decodeUnknownSync(rpc.payloadSchema);
    expect(decode({ ...payload, callId: "call" })).toMatchObject({ callId: "call" });
    expect(decode(payload)).toMatchObject(payload);
  });

  it("still requires callId for commands", () => {
    const rpc = DesktopRpcs.requests.get("runCommand")!;
    const decode = Schema.decodeUnknownSync(rpc.payloadSchema);
    const payload = {
      conversationId: "chat",
      command: "true",
      folder: "work",
      timeoutMs: 100,
      network: "none",
    };
    expect(() => decode(payload)).toThrow();
    expect(decode({ ...payload, callId: "call" })).toMatchObject({ callId: "call" });
  });
});
