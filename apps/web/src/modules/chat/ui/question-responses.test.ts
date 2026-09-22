import { describe, expect, it } from "vitest";
import { associateQuestionResponses } from "./question-responses.ts";
import { formatQuestionResponse, type QuestionResponse } from "~/modules/tools/ask-user-schema.ts";

const questions = [
  {
    question: "Which detail level?",
    options: [{ label: "Brief" }, { label: "Full" }],
    multiSelect: false,
  },
];
const assistant = {
  id: "assistant",
  role: "assistant",
  status: "complete",
  content: "Choose a level.",
};
const call = {
  id: "ask",
  messageId: assistant.id,
  toolName: "ask_user",
  status: "complete",
  arguments: { questions },
  result: { v: 1, outcome: "presented", questions },
};
const answers: QuestionResponse = { kind: "answers", answers: [{ selected: [0], custom: "" }] };
const user = (response: QuestionResponse = answers) => ({
  id: "user",
  role: "user",
  status: "complete",
  content: formatQuestionResponse(questions, response)!,
  questionResponse: { v: 1, response },
});

describe("associateQuestionResponses", () => {
  it("folds a reply to a steered answer's questions past the steer between them", () => {
    const steer = {
      id: "steer",
      role: "user",
      status: "complete",
      content: "shorter please",
      steeredIntoMessageId: assistant.id,
    };
    const result = associateQuestionResponses([assistant, steer, user()], [call], []);
    expect(result.byAssistant.get(assistant.id)?.messageId).toBe("user");
    expect([...result.hiddenMessageIds]).toEqual(["user"]);
  });

  it.each([
    answers,
    { kind: "skip" } as const,
    { kind: "answers", answers: [{ selected: [], custom: "My own answer" }] } as const,
  ])("resolves explicit valid %j metadata without altering raw history", (response) => {
    const messages = [
      assistant,
      user(response),
      { id: "next", role: "assistant", status: "error", content: "" },
    ];
    const result = associateQuestionResponses(messages, [call], []);
    expect(result.hiddenMessageIds).toEqual(new Set(["user"]));
    expect(result.byAssistant.get("assistant")).toEqual({
      callId: "ask",
      messageId: "user",
      response,
    });
    expect(messages).toHaveLength(3);
    expect(messages[1]!.content).toBe(formatQuestionResponse(questions, response));
  });

  it.each([
    undefined,
    null,
    { v: 2, response: answers },
    { v: 1, response: { kind: "answers", answers: [] } },
    { v: 1, response: { kind: "answers", answers: [{ selected: [3], custom: "" }] } },
    { v: 1, response: { kind: "answers", answers: [{ selected: [0, 1], custom: "" }] } },
  ])("fails visible on absent, unknown, or invalid metadata %j", (questionResponse) => {
    expect(
      associateQuestionResponses([assistant, { ...user(), questionResponse }], [call], [])
        .hiddenMessageIds.size,
    ).toBe(0);
  });

  it("never infers structured intent from ordinary Q1-like content", () => {
    expect(
      associateQuestionResponses([assistant, { ...user(), questionResponse: null }], [call], [])
        .hiddenMessageIds.size,
    ).toBe(0);
  });

  it("requires immediate raw adjacency, not adjacency after display filtering", () => {
    const messages = [
      assistant,
      { id: "system", role: "system", status: "complete", content: "hidden" },
      user(),
    ];
    expect(associateQuestionResponses(messages, [call], []).hiddenMessageIds.size).toBe(0);
  });

  it.each(["streaming", "error", "aborted"])(
    "keeps replies visible when either owner or reply is %s",
    (status) => {
      expect(
        associateQuestionResponses([{ ...assistant, status }, user()], [call], []).hiddenMessageIds
          .size,
      ).toBe(0);
      expect(
        associateQuestionResponses([assistant, { ...user(), status }], [call], []).hiddenMessageIds
          .size,
      ).toBe(0);
    },
  );

  it("fails visible on attachment-bearing replies or mismatched canonical content", () => {
    expect(
      associateQuestionResponses([assistant, user()], [call], [{ messageId: "user" }])
        .hiddenMessageIds.size,
    ).toBe(0);
    expect(
      associateQuestionResponses([assistant, { ...user(), content: "Q1: Full" }], [call], [])
        .hiddenMessageIds.size,
    ).toBe(0);
  });

  it("requires exactly one validated successful durable presentation", () => {
    for (const calls of [
      [],
      [{ ...call, status: "error" }],
      [call, { ...call, id: "other" }],
      [call, { ...call, id: "other", arguments: null }],
      [{ ...call, result: null }],
    ]) {
      expect(associateQuestionResponses([assistant, user()], calls, []).hiddenMessageIds.size).toBe(
        0,
      );
    }
  });

  it("fails visible on malformed/mismatched arguments and URL-bearing option labels", () => {
    for (const argumentsValue of [
      null,
      { questions: [] },
      { questions: [{ ...questions[0]!, question: "Different question" }] },
    ]) {
      expect(
        associateQuestionResponses(
          [assistant, user()],
          [{ ...call, arguments: argumentsValue }],
          [],
        ).hiddenMessageIds.size,
      ).toBe(0);
    }
    const urlQuestions = [
      { ...questions[0]!, options: [{ label: "https://example.com" }, { label: "Full" }] },
    ];
    expect(
      associateQuestionResponses(
        [assistant, { ...user(), content: "Q1: https://example.com" }],
        [
          {
            ...call,
            arguments: { questions: urlQuestions },
            result: { ...call.result, questions: urlQuestions },
          },
        ],
        [],
      ).hiddenMessageIds.size,
    ).toBe(0);
  });

  it("derives branch associations from copied rows without references to the source chat", () => {
    const branchAssistant = { ...assistant, id: "fork-assistant" };
    const branchUser = { ...user(), id: "fork-user" };
    const branchCall = { ...call, id: "fork-ask", messageId: branchAssistant.id };
    expect(associateQuestionResponses([branchAssistant], [branchCall], []).byAssistant.size).toBe(
      0,
    );
    expect(
      associateQuestionResponses([branchAssistant, branchUser], [branchCall], []).byAssistant.get(
        "fork-assistant",
      ),
    ).toMatchObject({ callId: "fork-ask", messageId: "fork-user" });
  });
});
