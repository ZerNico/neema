import { describe, expect, it } from "vitest";
import { associateQuestionResponses } from "./question-responses.ts";
import type { QuestionResponse } from "~/modules/tools/ask-user-schema.ts";

const assistant = { id: "assistant", role: "assistant", status: "complete" };
const call = { id: "ask", messageId: assistant.id, toolName: "ask_user" };
const answers: QuestionResponse = { kind: "answers", answers: [{ selected: [0], custom: "" }] };
const user = (response: QuestionResponse = answers, callId = call.id) => ({
  id: "user",
  role: "user",
  status: "complete",
  questionResponse: { v: 1, callId, response },
});

describe("associateQuestionResponses", () => {
  it.each([
    answers,
    { kind: "skip" } as const,
    { kind: "answers", answers: [{ selected: [], custom: "My own answer" }] } as const,
  ])("folds an answer %j into the card of the call it names", (response) => {
    const result = associateQuestionResponses([assistant, user(response)], [call]);
    expect(result.hiddenMessageIds).toEqual(new Set(["user"]));
    expect(result.byAssistant.get(assistant.id)).toEqual({
      callId: "ask",
      messageId: "user",
      response,
    });
  });

  it("keeps which connected app answered, since the reply itself is folded away", () => {
    const result = associateQuestionResponses(
      [assistant, { ...user(), originClientName: "Claude" }],
      [call],
    );
    expect(result.byAssistant.get(assistant.id)?.originClientName).toBe("Claude");
  });

  // Placement no longer decides anything: a steer or any other row between the
  // two changes nothing, since the answer names its question.
  it("folds by the named call wherever the answer sits", () => {
    const steer = { id: "steer", role: "user", status: "complete", steeredIntoMessageId: "x" };
    const result = associateQuestionResponses([assistant, steer, user()], [call]);
    expect(result.byAssistant.get(assistant.id)?.messageId).toBe("user");
  });

  it.each([
    undefined,
    null,
    { v: 2, callId: "ask", response: answers },
    { v: 1, response: answers },
    { v: 1, callId: "ask", response: { kind: "answers", answers: [] } },
  ])("leaves a message with absent or invalid metadata %j visible", (questionResponse) => {
    expect(
      associateQuestionResponses([assistant, { ...user(), questionResponse }], [call])
        .hiddenMessageIds.size,
    ).toBe(0);
  });

  it("leaves an answer visible when the call it names is not in this chat", () => {
    expect(
      associateQuestionResponses([assistant, user(answers, "elsewhere")], [call]).hiddenMessageIds
        .size,
    ).toBe(0);
    expect(
      associateQuestionResponses([assistant, user()], [{ ...call, toolName: "web_search" }])
        .hiddenMessageIds.size,
    ).toBe(0);
  });

  it.each(["streaming", "error", "aborted"])("leaves a %s answer visible", (status) => {
    expect(
      associateQuestionResponses([assistant, { ...user(), status }], [call]).hiddenMessageIds.size,
    ).toBe(0);
  });
});
