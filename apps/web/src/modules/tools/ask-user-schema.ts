import { Option, Schema } from "effect";

const text = (max: number) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(max),
    Schema.makeFilter((value) => value.trim().length > 0),
  );

export const AskUserQuestion = Schema.Struct({
  question: text(1000),
  header: Schema.optionalKey(text(40)),
  options: Schema.Array(
    Schema.Struct({ label: text(160), description: Schema.optionalKey(text(500)) }),
  ).check(Schema.isMaxLength(4)),
  multiSelect: Schema.Boolean,
}).check(
  Schema.makeFilter(
    (value) =>
      (value.options.length === 0 ? !value.multiSelect : value.options.length >= 2) &&
      new Set(value.options.map((option) => option.label.trim().toLowerCase())).size ===
        value.options.length,
  ),
);
export type AskUserQuestion = typeof AskUserQuestion.Type;

export const AskUserParams = Schema.Struct({
  questions: Schema.Array(AskUserQuestion).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
});
export type AskUserParams = typeof AskUserParams.Type;

export const AskUserResult = Schema.Union([
  Schema.Struct({
    v: Schema.Literals([1]),
    outcome: Schema.Literals(["presented"]),
    questions: AskUserParams.fields.questions,
  }),
  Schema.Struct({
    v: Schema.Literals([1]),
    outcome: Schema.Literals(["rejected"]),
    message: Schema.String,
  }),
]);
export type AskUserResult = typeof AskUserResult.Type;

export const QuestionResponse = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["skip"]) }),
  Schema.Struct({
    kind: Schema.Literals(["answers"]),
    answers: Schema.Array(
      Schema.Struct({
        selected: Schema.Array(
          Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(3)),
        ).check(Schema.isMaxLength(4)),
        custom: Schema.String.check(Schema.isMaxLength(4000)),
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  }),
]);
export type QuestionResponse = typeof QuestionResponse.Type;

/** A message that answers an `ask_user` batch, naming the call it answers. */
export const StoredQuestionResponse = Schema.Struct({
  v: Schema.Literals([1]),
  callId: Schema.String,
  response: QuestionResponse,
});
export type StoredQuestionResponse = typeof StoredQuestionResponse.Type;

export const readQuestionResponse = (value: unknown): StoredQuestionResponse | null =>
  Option.getOrNull(Schema.decodeUnknownOption(StoredQuestionResponse)(value));

/**
 * Only explicit selections and user-written text enter the user role. Questions,
 * descriptions and unselected options remain assistant-authored context.
 */
export function formatQuestionResponse(
  questions: AskUserParams["questions"],
  response: QuestionResponse,
): string | null {
  if (response.kind === "skip")
    return "I skipped the clarification questions. Continue if possible without those answers; skipping is not approval for any action.";
  if (response.answers.length !== questions.length) return null;
  const lines: string[] = [];
  for (const [index, question] of questions.entries()) {
    const answer = response.answers[index]!;
    const custom = answer.custom.trim();
    if (
      answer.custom.length > 4000 ||
      new Set(answer.selected).size !== answer.selected.length ||
      answer.selected.some(
        (choice) => !Number.isInteger(choice) || choice < 0 || choice >= question.options.length,
      )
    )
      return null;
    const count = answer.selected.length + (custom ? 1 : 0);
    if (question.multiSelect ? count < 1 : count !== 1) return null;
    const values = answer.selected.map((choice) => question.options[choice]!.label.trim());
    if (custom) values.push(custom);
    lines.push(`Q${index + 1}: ${values.join("; ")}`);
  }
  const content = lines.join("\n\n");
  return content.length <= 32_000 ? content : null;
}

export function formatQuestionContext(questions: AskUserParams["questions"]): string {
  return (
    "Clarification questions presented to the user:\n" +
    questions
      .map(
        (question, index) =>
          `Q${index + 1}: ${question.question}\n` +
          question.options
            .map(
              (option, choice) =>
                `${choice + 1}. ${option.label}${option.description ? `: ${option.description}` : ""}`,
            )
            .join("\n") +
          `\n${question.multiSelect ? "Select one or more, and/or write a custom answer." : "Choose one or write a custom answer."}`,
      )
      .join("\n\n")
  );
}

/**
 * Durable answer association must agree with the arguments the tool accepted,
 * not only a decodable result left on an inconsistent historical row.
 */
export function readStoredQuestionPresentation(
  args: unknown,
  result: unknown,
): AskUserParams["questions"] | null {
  const params = Schema.decodeUnknownOption(AskUserParams)(args);
  const questions = readPresentedQuestions(result);
  return Option.isSome(params) &&
    questions &&
    JSON.stringify(params.value.questions) === JSON.stringify(questions)
    ? questions
    : null;
}

export function readPresentedQuestions(value: unknown): AskUserParams["questions"] | null {
  const decoded = Schema.decodeUnknownOption(AskUserResult)(value);
  return Option.isSome(decoded) && decoded.value.outcome === "presented"
    ? decoded.value.questions
    : null;
}
