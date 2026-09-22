import { describe, expect, it } from "vitest";
import { projectAssistantBody } from "./assistant-body.ts";
import type { CompactionActivity, ToolActivity } from "../client/use-message-stream.ts";

const web = (callId: string, textOffset: number, callIndex = 0): ToolActivity => ({
  family: "web",
  name: "web_search",
  callId,
  textOffset,
  turnIndex: 0,
  callIndex,
  status: "complete",
  targets: [callId],
});
const memory = (textOffset: number, callIndex = 1): ToolActivity => ({
  family: "memory",
  name: "save_memory",
  callId: "memory",
  textOffset,
  turnIndex: 0,
  callIndex,
  status: "complete",
  outcome: "created",
});
const compaction = (
  textOffset: number,
  beforeTurnIndex = 0,
  passIndex = 0,
): CompactionActivity => ({
  eventId: `compact-${beforeTurnIndex}-${passIndex}`,
  textOffset,
  beforeTurnIndex,
  passIndex,
  scope: "history",
  status: "complete",
});

describe("projectAssistantBody", () => {
  it("alternates original text and every activity family, including same-round post-tool text", () => {
    const content = "Intro. Search done. Memory done. Question done.";
    const result = projectAssistantBody({
      content,
      streaming: false,
      tools: [
        web("web", 7),
        memory(20),
        {
          family: "ask",
          name: "ask_user",
          callId: "ask",
          status: "complete",
          turnIndex: 0,
          callIndex: 2,
          textOffset: 33,
          questions: [],
        },
      ],
      compactions: [],
    });
    expect(result.chronological).toBe(true);
    expect(result.parts.map((part) => part.kind)).toEqual([
      "text",
      "web",
      "text",
      "tool",
      "text",
      "tool",
      "text",
    ]);
    expect(
      result.parts
        .filter((part) => part.kind === "text")
        .map((part) => part.content)
        .join(""),
    ).toBe(content);
    expect(
      result.parts.filter((part) => part.kind === "text").every((part) => !part.streaming),
    ).toBe(true);
  });

  it("uses UTF-16 positions without losing Unicode or whitespace", () => {
    const intro = "Hello 😀\n\n";
    const outro = "漢字 café\n";
    const { parts } = projectAssistantBody({
      content: intro + outro,
      streaming: false,
      tools: [web("web", intro.length)],
      compactions: [],
    });
    expect(parts[0]).toMatchObject({ content: intro });
    expect(parts[2]).toMatchObject({ content: outro });
  });

  it("sorts equal-offset compactions before their turn and tool siblings by call index", () => {
    const { parts } = projectAssistantBody({
      content: "",
      streaming: false,
      tools: [memory(0, 2), web("b", 0, 1), web("a", 0, 0)],
      compactions: [compaction(0, 0, 1), compaction(0)],
    });
    expect(parts.map((part) => part.key)).toEqual([
      "compaction-compact-0-0",
      "compaction-compact-0-1",
      "web-a",
      "tool-memory",
    ]);
    expect(parts[2]).toMatchObject({ activities: [{ callId: "a" }, { callId: "b" }] });
  });

  it("groups only adjacent web calls, not across prose or another family", () => {
    const { parts } = projectAssistantBody({
      content: "ab",
      streaming: false,
      tools: [web("a", 0), web("b", 0, 1), memory(0, 2), web("c", 0, 3), web("d", 1, 4)],
      compactions: [],
    });
    expect(parts.map((part) => part.kind)).toEqual(["web", "tool", "web", "text", "web", "text"]);
  });

  it("waits for the smoothed prefix, without clamping future anchors or moving cards", () => {
    const tools = [web("web", 5)];
    const before = projectAssistantBody({
      content: "abc",
      rawTextLength: 9,
      streaming: true,
      tools,
      compactions: [],
    });
    expect(before.parts).toEqual([
      { kind: "text", key: "text-0", content: "abc", streaming: true },
    ]);
    const at = projectAssistantBody({
      content: "abcde",
      rawTextLength: 9,
      streaming: true,
      tools,
      compactions: [],
    });
    expect(at.parts[0]).toMatchObject({ key: "text-0", content: "abcde", streaming: false });
    expect(at.parts[1]).toMatchObject({ key: "web-web" });
    const later = projectAssistantBody({
      content: "abcdefghi",
      rawTextLength: 9,
      streaming: true,
      tools,
      compactions: [],
    });
    expect(later.parts.slice(0, 2)).toEqual(at.parts);
    expect(later.parts[2]).toMatchObject({ key: "text-5", content: "fghi", streaming: true });
  });

  it("waits when a durable activity is ahead of the streaming text snapshot", () => {
    const result = projectAssistantBody({
      content: "ab",
      rawTextLength: 2,
      streaming: true,
      tools: [web("web", 5)],
      compactions: [],
    });
    expect(result.chronological).toBe(true);
    expect(result.parts.map((part) => part.kind)).toEqual(["text"]);
  });

  it.each([undefined, -1, 0.5, NaN, Infinity, 100])(
    "falls back for the whole completed message when an offset is %s",
    (textOffset) => {
      const broken = { ...web("broken", 0), ...(textOffset === undefined ? {} : { textOffset }) };
      if (textOffset === undefined) delete broken.textOffset;
      const result = projectAssistantBody({
        content: "abc",
        streaming: false,
        tools: [web("known", 1), broken],
        compactions: [],
      });
      expect(result.chronological).toBe(false);
      expect(result.parts.at(-1)).toMatchObject({ kind: "text", content: "abc" });
      expect(result.parts.filter((part) => part.kind === "text")).toHaveLength(1);
    },
  );

  it("falls back rather than inventing chronology for contradictory logical ordering", () => {
    const result = projectAssistantBody({
      content: "abcdef",
      streaming: false,
      tools: [web("first", 4), memory(2)],
      compactions: [],
    });
    expect(result.chronological).toBe(false);
    expect(result.parts.map((part) => part.kind)).toEqual(["web", "tool", "text"]);
  });
});

describe("generated image body ordering", () => {
  const image = (id: string, callIndex: number, textOffset = 0) => ({
    v: 1 as const,
    attachment: {
      id,
      fileName: `${id}.png`,
      size: 10,
      mediaType: "image/png",
      kind: "image" as const,
    },
    textOffset,
    turnIndex: 0,
    eventIndex: callIndex + 1,
    callIndex,
  });
  it("keeps image/tool/image boundaries at the same text offset", () => {
    const result = projectAssistantBody({
      content: "",
      streaming: false,
      tools: [web("search", 0, 0)],
      compactions: [],
      files: [image("before", 0), image("after", 1)],
    });
    expect(result.parts.map((part) => part.kind)).toEqual(["file", "web", "file"]);
  });
  it("waits for smoothed UTF-16 text to reach the image anchor", () => {
    expect(
      projectAssistantBody({
        content: "a",
        streaming: true,
        tools: [],
        compactions: [],
        files: [image("image", 0, 3)],
      }).parts.map((part) => part.kind),
    ).toEqual(["text"]);
    expect(
      projectAssistantBody({
        content: "a😀",
        streaming: true,
        tools: [],
        compactions: [],
        files: [image("image", 0, 3)],
      }).parts.map((part) => part.kind),
    ).toEqual(["text", "file"]);
  });
});
