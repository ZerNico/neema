import { describe, expect, it } from "vitest";
import { applyToolChunk } from "../client/use-message-stream.ts";
import { toActivity } from "./stored-activities.ts";

describe("toActivity", () => {
  const row = {
    id: "tool-1",
    arguments: {},
    result: {},
    status: "complete" as const,
    turnIndex: 1,
    callIndex: 2,
    error: null,
  };

  it("accepts live research progress after loading a running row without progress", () => {
    const initial = toActivity({
      ...row,
      toolName: "deep_research",
      family: "research" as const,
      status: "running",
      result: null,
    });
    const progress = {
      runId: "run-1",
      phase: "researching",
      usageComplete: true,
      limitations: [],
      tasks: [],
    };
    const tools = applyToolChunk(
      [initial],
      JSON.stringify({
        v: 1,
        family: "research",
        name: "deep_research",
        callId: row.id,
        runId: progress.runId,
        phase: "progress",
        progress,
      }),
    );
    expect(initial.status).toBe("running");
    expect(tools[0]).toMatchObject({ status: "running", runId: "run-1", progress });
    const completed = applyToolChunk(
      tools,
      JSON.stringify({
        v: 1,
        family: "research",
        name: "deep_research",
        callId: row.id,
        runId: progress.runId,
        phase: "result",
        progress: { ...progress, phase: "complete" },
        ok: true,
      }),
    );
    expect(completed[0]).toMatchObject({ status: "complete", runId: "run-1" });
  });

  it.each(["complete", "error"] as const)(
    "keeps %s research without progress terminal",
    (status) => {
      expect(
        toActivity({
          ...row,
          toolName: "deep_research",
          family: "research" as const,
          status,
          result: null,
        }).status,
      ).toBe("error");
    },
  );

  it("hydrates save_memory as summary-only memory activity", () => {
    expect(
      toActivity({
        ...row,
        toolName: "save_memory",
        family: "memory" as const,
        arguments: { content: "private memory" },
        result: {
          outcome: "updated",
          content: "private memory",
          sources: [{ url: "https://should-not-appear.dev" }],
        },
      }),
    ).toEqual({
      family: "memory",
      callId: "tool-1",
      name: "save_memory",
      turnIndex: 1,
      callIndex: 2,
      status: "complete",
      outcome: "updated",
    });
  });

  it("hydrates a refused save with its fixed reason and nothing else", () => {
    expect(
      toActivity({
        ...row,
        toolName: "save_memory",
        family: "memory" as const,
        status: "error",
        result: { outcome: "rejected", reason: "sensitive", message: "private text" },
      }),
    ).toEqual({
      family: "memory",
      callId: "tool-1",
      name: "save_memory",
      turnIndex: 1,
      callIndex: 2,
      status: "error",
      outcome: "rejected",
      reason: "sensitive",
    });
    expect(
      toActivity({
        ...row,
        toolName: "save_memory",
        family: "memory" as const,
        status: "error",
        result: { outcome: "rejected", reason: "not a real reason" },
      }),
    ).not.toHaveProperty("reason");
  });

  it("hydrates existing tool names as web activity", () => {
    expect(
      toActivity({
        ...row,
        toolName: "web_search",
        family: "web" as const,
        arguments: { queries: ["effect"] },
        result: { resultCount: 2 },
      }),
    ).toEqual({
      family: "web",
      callId: "tool-1",
      name: "web_search",
      turnIndex: 1,
      callIndex: 2,
      targets: ["effect"],
      status: "complete",
      resultCount: 2,
    });
  });
});

const askQuestions = [
  {
    question: "Which direction?",
    options: [{ label: "Simple" }, { label: "Detailed" }],
    multiSelect: false,
  },
];
const askRow = {
  id: "ask-1",
  messageId: "m-answer",
  toolName: "ask_user",
  family: "ask" as const,
  arguments: { questions: askQuestions },
  result: { v: 1, outcome: "presented", questions: askQuestions },
  status: "complete" as const,
  turnIndex: 1,
  callIndex: 2,
  error: null,
};

it("hydrates validated questions with live-result parity and rejects unknown versions", () => {
  expect(toActivity(askRow)).toEqual({
    family: "ask",
    callId: "ask-1",
    name: "ask_user",
    status: "complete",
    turnIndex: 1,
    callIndex: 2,
    questions: askQuestions,
  });
  expect(toActivity({ ...askRow, result: { ...askRow.result, v: 2 } })).toMatchObject({
    family: "ask",
    status: "error",
  });
  expect(toActivity({ ...askRow, result: null })).not.toHaveProperty("questions");
});

it("hydrates document source activities only from an explicit knowledge envelope", () => {
  const source = {
    kind: "document",
    index: 1,
    title: "Contract",
    snippet: "Term",
    read: true,
    collectionId: "c",
    documentId: "d",
    versionId: "v",
    startOffset: 0,
    endOffset: 4,
    page: null,
    headingPath: "",
  };
  const result = {
    family: "knowledge",
    ok: true,
    summary: {
      targets: [],
      documentsListed: 0,
      passagesReturned: 1,
      remainingOps: 63,
      coverage: "Excerpt only",
    },
    sources: [source],
  };
  const row = {
    id: "read",
    toolName: "read_knowledge_document",
    family: "knowledge" as const,
    turnIndex: 0,
    callIndex: 0,
    textOffset: 4,
    status: "complete" as const,
    arguments: {},
    result,
    error: null,
  };
  expect(toActivity(row)).toMatchObject({
    family: "knowledge",
    status: "complete",
    textOffset: 4,
    sources: [source],
  });
  expect(toActivity({ ...row, result: { ...result, family: undefined } })).toMatchObject({
    family: "knowledge",
    status: "error",
  });
  expect(toActivity({ ...row, result: { ...result, family: undefined } })).not.toHaveProperty(
    "sources",
  );
});
