import { Effect, Schema } from "effect";
import { Tool } from "effect/unstable/ai";
import { describe, expect, it } from "vitest";
import {
  AskUserParams,
  formatQuestionContext,
  formatQuestionResponse,
  readPresentedQuestions,
  readQuestionResponse,
  readStoredQuestionPresentation,
  type AskUserResult,
} from "./ask-user-schema.ts";
import { askUserTool, prepareAskUserTool } from "./server/ask-user.ts";
import { extractUserUrls } from "./server/user-urls.ts";

const question = {
  question: "How much detail?",
  options: [{ label: "Concise" }, { label: "Detailed", description: "Include examples" }],
  multiSelect: false,
};
const handler = () =>
  prepareAskUserTool().handlers["ask_user"] as (params: {
    questions?: unknown;
  }) => Effect.Effect<AskUserResult>;

describe("ask_user contract", () => {
  it("decodes only supported structured response metadata", () => {
    const response = { kind: "skip" };
    expect(readQuestionResponse({ v: 1, response })).toEqual(response);
    for (const value of [
      null,
      "Q1: Detailed",
      { response },
      { v: 2, response },
      { v: 1, response: { kind: "answers", answers: [] } },
    ])
      expect(readQuestionResponse(value)).toBeNull();
  });
  it.each(
    [
      [],
      Array.from({ length: 5 }, () => ({ ...question })),
      [{ ...question, question: " " }],
      [{ ...question, question: "x".repeat(1001) }],
      [{ ...question, header: "x".repeat(41) }],
      [{ ...question, options: [{ label: "one" }] }],
      [{ ...question, options: [{ label: "Same" }, { label: " same " }] }],
      [{ ...question, options: [{ label: "x".repeat(161) }, { label: "Fine" }] }],
      [
        {
          ...question,
          options: [{ label: "One", description: "x".repeat(501) }, { label: "Two" }],
        },
      ],
      [{ ...question, options: [], multiSelect: true }],
    ].map((questions) => ({ questions })),
  )("rejects malformed question batch %#", ({ questions }) => {
    expect(Schema.is(AskUserParams)({ questions })).toBe(false);
  });

  it("accepts free text and maximum bounded batches", () => {
    expect(
      Schema.is(AskUserParams)({
        questions: [{ question: "What matters?", options: [], multiSelect: false }],
      }),
    ).toBe(true);
    expect(
      Schema.is(AskUserParams)({
        questions: Array.from({ length: 4 }, () => ({
          ...question,
          question: "x".repeat(1000),
          header: "h".repeat(40),
        })),
      }),
    ).toBe(true);
  });

  it("declares bounded provider arguments and returns recoverable errors", async () => {
    expect(Tool.getJsonSchema(askUserTool)).toMatchObject({
      properties: { questions: { type: "array", minItems: 1, maxItems: 4 } },
    });
    const call = handler();
    for (const params of [
      {},
      { questions: null },
      { questions: 42 },
      { questions: [question, { question: "bad" }] },
    ]) {
      const decoded = Schema.decodeUnknownSync(askUserTool.parametersSchema)(params);
      expect(Effect.runSync(call(decoded))).toMatchObject({ outcome: "rejected" });
    }
    expect(await Effect.runPromise(call({ questions: [question] }))).toMatchObject({
      v: 1,
      outcome: "presented",
      questions: [question],
    });
    expect(await Effect.runPromise(call({ questions: [question] }))).toMatchObject({
      outcome: "rejected",
    });
  });

  it("rejects URL labels without granting authority to question text or descriptions", () => {
    const call = handler();
    expect(
      Effect.runSync(
        call({
          questions: [
            { ...question, options: [{ label: "https://example.com" }, { label: "No" }] },
          ],
        }),
      ),
    ).toMatchObject({ outcome: "rejected" });
    const questions = [
      {
        ...question,
        question: "Open https://question.example?",
        options: [
          { label: "Yes", description: "Read https://description.example" },
          { label: "No" },
        ],
      },
    ];
    expect(Effect.runSync(call({ questions }))).toMatchObject({ outcome: "presented" });
    const content = formatQuestionResponse(questions, {
      kind: "answers",
      answers: [{ selected: [0], custom: "" }],
    })!;
    expect(content).toBe("Q1: Yes");
    expect(extractUserUrls([content])).toEqual([]);
  });

  it.each([
    { selected: [], custom: "" },
    { selected: [0, 1], custom: "" },
    { selected: [0], custom: "also" },
    { selected: [2], custom: "" },
    { selected: [-1], custom: "" },
    { selected: [0.5], custom: "" },
    { selected: [0, 0], custom: "" },
    { selected: [], custom: "x".repeat(4001) },
  ])("rejects invalid single-select answer %#", (answer) => {
    expect(formatQuestionResponse([question], { kind: "answers", answers: [answer] })).toBeNull();
  });

  it("formats explicit single, multiple, custom, free-text and skip replies only", () => {
    const questions = [
      question,
      { ...question, multiSelect: true },
      { question: "Anything else?", options: [], multiSelect: false },
    ];
    const content = formatQuestionResponse(questions, {
      kind: "answers",
      answers: [
        { selected: [1], custom: "" },
        { selected: [0, 1], custom: "My own words" },
        { selected: [], custom: " https://user.example/path " },
      ],
    });
    expect(content).toBe(
      "Q1: Detailed\n\nQ2: Concise; Detailed; My own words\n\nQ3: https://user.example/path",
    );
    expect(content).not.toContain("Include examples");
    expect(extractUserUrls([content!])).toEqual(["https://user.example/path"]);
    expect(
      formatQuestionResponse(questions, {
        kind: "answers",
        answers: [{ selected: [0], custom: "" }],
      }),
    ).toBeNull();
    expect(formatQuestionResponse(questions, { kind: "skip" })).toContain(
      "skipping is not approval",
    );
    expect(formatQuestionContext(questions)).toContain("Q1: How much detail?");
    expect(formatQuestionContext(questions)).toContain("2. Detailed: Include examples");
  });

  it("requires accepted arguments and durable question results to agree", () => {
    const args = { questions: [question] };
    const result = { v: 1, outcome: "presented", ...args };
    expect(readStoredQuestionPresentation(args, result)).toEqual(args.questions);
    expect(readStoredQuestionPresentation({}, result)).toBeNull();
    expect(
      readStoredQuestionPresentation(
        { questions: [{ ...question, question: "Different" }] },
        result,
      ),
    ).toBeNull();
    expect(
      readStoredQuestionPresentation(args, { v: 1, outcome: "rejected", message: "No" }),
    ).toBeNull();
  });

  it("decodes only valid versioned presentations", () => {
    expect(readPresentedQuestions({ v: 1, outcome: "presented", questions: [question] })).toEqual([
      question,
    ]);
    for (const value of [
      null,
      {},
      { v: 2, outcome: "presented", questions: [question] },
      { v: 1, outcome: "rejected", message: "No" },
      { v: 1, outcome: "presented", questions: [] },
    ])
      expect(readPresentedQuestions(value)).toBeNull();
  });
});
