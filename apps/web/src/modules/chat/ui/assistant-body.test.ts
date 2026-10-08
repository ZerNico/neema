import { describe, expect, it } from "vitest";
import { projectAssistantBody as projectGrouped } from "./assistant-body.ts";
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

const desktop = (callId: string, name: string, callIndex: number): ToolActivity => ({
  family: "desktop",
  name: name as Extract<ToolActivity, { family: "desktop" }>["name"],
  callId,
  textOffset: 0,
  turnIndex: 0,
  callIndex,
  status: "complete",
});

/** Order and anchoring, with runs of work unfolded into their steps. */
const projectAssistantBody = (input: Parameters<typeof projectGrouped>[0]) => {
  const projected = projectGrouped(input);
  return {
    ...projected,
    parts: projected.parts.flatMap((part) => (part.kind === "work" ? part.steps : [part])),
  };
};

describe("projectAssistantBody", () => {
  it("joins a run of browser calls into one row, apart from other desktop calls", () => {
    const result = projectAssistantBody({
      content: "",
      streaming: false,
      tools: [
        desktop("open", "browser_open", 0),
        desktop("click", "browser_click", 1),
        desktop("read", "read_local_file", 2),
        desktop("shot", "browser_snapshot", 3),
      ],
      compactions: [],
    });
    expect(
      result.parts.map((part) =>
        part.kind === "browser" ? part.activities.map((activity) => activity.callId) : part.kind,
      ),
    ).toEqual([["open", "click"], "tool", ["shot"]]);
  });

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

  it("keeps a ui block whole and shows an activity anchored inside it after it", () => {
    const intro = "Intro\n\n";
    const block = "```ui\n<text>a</text>\n<text>b</text>\n```\n";
    const outro = "After";
    const inside = intro.length + block.indexOf("<text>b");
    const { parts } = projectAssistantBody({
      content: intro + block + outro,
      streaming: false,
      tools: [web("web", inside)],
      compactions: [],
    });
    expect(parts.map((p) => p.kind)).toEqual(["text", "web", "text"]);
    expect(parts[0]).toMatchObject({ content: intro + block, start: 0 });
    expect(parts[2]).toMatchObject({ content: outro, start: (intro + block).length });
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

  it("drops tool loads, so loading between two web calls keeps them one row", () => {
    const load: ToolActivity = {
      family: "tool-load",
      name: "load_tools",
      callId: "load",
      textOffset: 0,
      turnIndex: 0,
      callIndex: 1,
      status: "complete",
      loaded: ["presentation"],
    };
    const { parts } = projectAssistantBody({
      content: "",
      streaming: false,
      tools: [web("a", 0), load, web("b", 0, 2)],
      compactions: [],
    });
    expect(parts.map((part) => part.kind)).toEqual(["web"]);
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
      { kind: "text", key: "text-0", content: "abc", streaming: true, start: 0 },
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

const steer = (textOffset: number, turnIndex = 0) => ({
  id: "steer-1",
  content: "make it about dogs",
  textOffset,
  turnIndex,
  attachments: [],
});

describe("projectAssistantBody steers", () => {
  const content = "Here is a cat poem. Here is a dog poem.";
  const offset = "Here is a cat poem. ".length;

  it("draws a steer between the text written before it and after it", () => {
    const { parts } = projectAssistantBody({
      content,
      streaming: false,
      tools: [],
      compactions: [],
      steers: [steer(offset)],
    });
    expect(parts.map((part) => (part.kind === "text" ? part.content : part.kind))).toEqual([
      "Here is a cat poem. ",
      "steer",
      "Here is a dog poem.",
    ]);
  });

  it("follows every activity of the round it came after", () => {
    const { parts } = projectAssistantBody({
      content,
      streaming: false,
      tools: [web("search", offset, 3)],
      compactions: [],
      steers: [steer(offset)],
    });
    expect(parts.map((part) => part.kind)).toEqual(["text", "web", "steer", "text"]);
  });

  it("waits for the smoothed text to reach it while streaming", () => {
    const { parts } = projectAssistantBody({
      content: "Here is a",
      streaming: true,
      tools: [],
      compactions: [],
      steers: [steer(offset)],
    });
    expect(parts.map((part) => part.kind)).toEqual(["text"]);
  });

  describe("working files", () => {
    const step = (
      callId: string,
      turnIndex: number,
      workingFileId?: string,
      status: "running" | "complete" = "complete",
    ): ToolActivity => ({
      family: "presentation",
      name: "edit_presentation",
      callId,
      textOffset: 0,
      turnIndex,
      callIndex: 0,
      status,
      ...(workingFileId ? { workingFileId } : {}),
    });
    const publish = (
      turnIndex: number,
      workingFileId: string,
      attachmentId?: string,
    ): ToolActivity => ({
      family: "tool-file",
      name: "publish_file",
      callId: `publish-${workingFileId}`,
      textOffset: 0,
      turnIndex,
      callIndex: 0,
      status: attachmentId ? "complete" : "running",
      workingFileId,
      ...(attachmentId ? { attachmentId } : {}),
    });
    const file = {
      v: 1 as const,
      attachment: {
        id: "deck",
        fileName: "Deck.pptx",
        size: 1,
        mediaType: "application/octet-stream",
        kind: "file" as const,
      },
      textOffset: 0,
      turnIndex: 3,
      eventIndex: 1,
      callIndex: 0,
    };
    const project = (tools: ToolActivity[], text = "", files = [file]) =>
      projectAssistantBody({ content: text, streaming: true, tools, compactions: [], files }).parts;

    it("folds a draft's steps and its publish into one step, its file a part of its own", () => {
      const parts = project([step("a", 0, "d1"), step("b", 1, "d1"), publish(2, "d1", "deck")]);
      expect(parts.map((part) => part.kind)).toEqual(["working-file", "file"]);
      expect(parts[0]).toMatchObject({ workingFileId: "d1", files: [file], final: true });
      expect(
        parts[0]?.kind === "working-file" && parts[0].steps.map((item) => item.callId),
      ).toEqual(["a", "b", "publish-d1"]);
      expect(parts[1]).toMatchObject({ file });
    });

    it("keeps a running step without a file ID in the draft before it", () => {
      const parts = project([step("a", 0, "d1"), step("b", 1, undefined, "running")], "", []);
      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({ kind: "working-file", newest: true });
    });

    it("puts the delivered file after the whole run of work, not inside it", () => {
      const grouped = projectGrouped({
        content: "",
        streaming: false,
        tools: [step("a", 0, "d1"), publish(1, "d1", "deck"), { ...web("w", 0), turnIndex: 2 }],
        compactions: [],
        files: [file],
      }).parts;
      expect(grouped.map((part) => part.kind)).toEqual(["work", "file"]);
      expect(grouped[0]?.kind === "work" && grouped[0].steps.map((part) => part.kind)).toEqual([
        "working-file",
        "web",
      ]);
    });

    it("starts a new part for another file or after intervening text", () => {
      expect(project([step("a", 0, "d1"), step("b", 1, "d2")], "", [])).toHaveLength(2);
      const split = projectAssistantBody({
        content: "Now the second pass.",
        streaming: false,
        tools: [step("a", 0, "d1"), { ...step("b", 1, "d1"), textOffset: 20 }],
        compactions: [],
      }).parts;
      expect(split.map((part) => part.kind)).toEqual(["working-file", "text", "working-file"]);
    });

    it("keeps every file: two created in a row, and a draft published twice", () => {
      const created = (callId: string, attachmentId: string, turnIndex: number): ToolActivity => ({
        family: "tool-file",
        name: "create_file",
        callId,
        textOffset: 0,
        turnIndex,
        callIndex: 0,
        status: "complete",
        attachmentId,
      });
      const delivered = (id: string, turnIndex: number) => ({
        ...file,
        attachment: { ...file.attachment, id, fileName: `${id}.csv` },
        turnIndex,
      });
      const two = project([created("c1", "a", 0), created("c2", "b", 1)], "", [
        delivered("a", 0),
        delivered("b", 1),
      ]);
      expect(two.map((part) => part.kind)).toEqual(["file", "file"]);
      const republished = project(
        [step("e", 0, "d1"), publish(1, "d1", "a"), { ...publish(2, "d1", "b"), callId: "p2" }],
        "",
        [delivered("a", 1), delivered("b", 2)],
      );
      expect(republished.filter((part) => part.kind === "file").map((part) => part.key)).toEqual([
        "file-a",
        "file-b",
      ]);
    });

    it("shows another tool's published file as its card alone, with no empty step", () => {
      const parts = project([publish(0, "custom-1", "deck")]);
      expect(parts).toEqual([{ kind: "file", key: "file-deck", file }]);
    });
  });
});

describe("runs of work", () => {
  it("fold reasoning and adjacent work into one part, broken by text and kept apart from what the person acts on", () => {
    const ask: ToolActivity = {
      family: "ask",
      name: "ask_user",
      callId: "ask",
      textOffset: 2,
      turnIndex: 0,
      callIndex: 3,
      status: "complete",
    };
    const { parts } = projectGrouped({
      content: "abcd",
      streaming: false,
      reasoning: true,
      tools: [web("a", 0), memory(0, 1), web("b", 1, 2), ask, web("c", 3, 4)],
      compactions: [],
    });
    expect(
      parts.map((part) =>
        part.kind === "work" ? `work(${part.steps.map((step) => step.kind).join(",")})` : part.kind,
      ),
    ).toEqual([
      "work(reasoning,web)",
      "tool",
      "text",
      "work(web)",
      "text",
      "tool",
      "text",
      "work(web)",
      "text",
    ]);
  });
});
