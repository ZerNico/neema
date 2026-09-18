import { useId, useRef, useState } from "react";
import type { AskToolActivity } from "../client/use-message-stream.ts";
import type { MessageTime } from "./timestamps.ts";
import type { ResolvedQuestionResponse } from "./question-responses.ts";
import { formatQuestionResponse, type QuestionResponse } from "~/modules/tools/ask-user-schema.ts";
import { Card, CardContent } from "~/ui/card.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Button } from "~/ui/primitives/button";
import { Label } from "~/ui/primitives/label";
import { Textarea } from "~/ui/primitives/textarea";
import { ToggleGroup, ToggleGroupItem } from "~/ui/primitives/toggle-group";

export interface ResolvedQuestionView extends ResolvedQuestionResponse {
  time?: MessageTime;
  onEdit?: () => void;
  editDisabled?: boolean;
  editState?: {
    /** False means the downstream deletion confirmation was cancelled. */
    onSave: (response: QuestionResponse) => Promise<boolean>;
    onCancel: () => void;
    disabled: boolean;
  };
}

export interface QuestionActions {
  resolved?: ResolvedQuestionView;
  /** Present only on the exact completed conversation tail. Rejects on failure. */
  onRespond?: (callId: string, response: QuestionResponse) => Promise<unknown>;
  disabled?: boolean;
}

export function AskUserBlock({
  activity,
  messageStatus,
  onRespond,
  resolved,
  disabled = false,
}: QuestionActions & { activity: AskToolActivity; messageStatus: string }) {
  const id = useId();
  const questions = activity.questions ?? [];
  const resolution = resolved?.callId === activity.callId ? resolved : undefined;
  const editState = resolution?.editState;
  const editing = editState !== undefined;
  const [wasEditing, setWasEditing] = useState(false);
  const [answers, setAnswers] = useState(() =>
    questions.map(() => ({ selected: [] as number[], custom: "" })),
  );
  // The running activity mounts before its result. Seed once when the validated
  // questions arrive; never reset an existing draft on refetch or failure.
  if (answers.length !== questions.length) {
    setAnswers(questions.map(() => ({ selected: [], custom: "" })));
  }
  const [pending, setPending] = useState<QuestionResponse["kind"] | null>(null);
  const [submitted, setSubmitted] = useState(false);
  if (editing !== wasEditing) {
    setWasEditing(editing);
    if (editing) {
      setAnswers(
        resolution?.response.kind === "answers"
          ? resolution.response.answers.map((answer) => ({
              selected: [...answer.selected],
              custom: answer.custom,
            }))
          : questions.map(() => ({ selected: [], custom: "" })),
      );
    }
  }
  const submitting = useRef(false);
  const preparing = messageStatus === "streaming";
  const actionable =
    messageStatus === "complete" &&
    activity.status === "complete" &&
    (editing || (!!onRespond && !submitted && !resolution));
  const locked = !actionable || (editState ? editState.disabled : disabled) || pending !== null;
  const response: QuestionResponse = { kind: "answers", answers };
  const valid = questions.length > 0 && formatQuestionResponse(questions, response) !== null;

  const submit = async (value: QuestionResponse) => {
    if (locked || submitting.current || (!onRespond && !editState)) return;
    if (formatQuestionResponse(questions, value) === null) return;
    submitting.current = true;
    setPending(value.kind);
    try {
      if (editState) {
        await editState.onSave(value);
      } else {
        await onRespond!(activity.callId, value);
        setSubmitted(true);
      }
    } catch {
      // The view owns the mutation toast and authoritative refetch. Retain every
      // choice and custom answer so a rejected request never destroys work.
    } finally {
      submitting.current = false;
      setPending(null);
    }
  };

  return (
    <Card
      className="mb-3 gap-4 py-4"
      aria-label="Clarification questions"
      aria-busy={pending !== null || undefined}
      data-answer-message-id={resolution?.messageId}
    >
      {preparing || activity.status === "error" || questions.length === 0 ? (
        <p className="text-muted-foreground px-4 text-xs">
          {preparing ? "Preparing questions…" : "These questions are unavailable."}
        </p>
      ) : !actionable && !resolution ? (
        <p className="text-muted-foreground px-4 text-xs">Previous questions · read-only</p>
      ) : null}
      {questions.length > 0 ? (
        <CardContent className="px-4">
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (valid) void submit(response);
            }}
          >
            {questions.map((question, index) => {
              const answer = answers[index] ?? { selected: [], custom: "" };
              const questionId = `${id}-question-${index}`;
              const customId = `${id}-custom-${index}`;
              const resolvedAnswer =
                resolution?.response.kind === "answers"
                  ? resolution.response.answers[index]
                  : undefined;
              return (
                <fieldset key={questionId} disabled={locked} className="min-w-0 space-y-2.5">
                  <legend
                    id={questionId}
                    className="mb-2 text-sm font-medium [overflow-wrap:anywhere]"
                  >
                    {question.header ? (
                      <span className="text-muted-foreground mb-1 block text-xs">
                        {question.header}
                      </span>
                    ) : null}
                    {questions.length > 1 ? `${index + 1}. ` : ""}
                    {question.question}
                  </legend>
                  {actionable || preparing ? (
                    <>
                      {question.options.length > 0 ? (
                        <ToggleGroup
                          aria-labelledby={questionId}
                          multiple={question.multiSelect}
                          value={answer.selected.map(String)}
                          disabled={locked}
                          variant="outline"
                          className="w-full flex-wrap items-stretch"
                          onValueChange={(values) => {
                            const selected = values.map(Number);
                            setAnswers((current) =>
                              current.map((item, i) =>
                                i === index
                                  ? {
                                      selected,
                                      custom:
                                        !question.multiSelect && selected.length > 0
                                          ? ""
                                          : item.custom,
                                    }
                                  : item,
                              ),
                            );
                          }}
                        >
                          {question.options.map((option, choice) => (
                            <ToggleGroupItem
                              key={option.label}
                              value={String(choice)}
                              aria-label={option.label}
                              // oxlint-disable-next-line shadcn/no-restyle -- a choice carries a label and an optional description, so it wraps to as many lines as it needs
                              className="h-auto min-h-10 min-w-0 max-w-full shrink rounded-2xl px-3 py-2 text-left whitespace-normal aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:text-foreground"
                            >
                              <span className="min-w-0 [overflow-wrap:anywhere]">
                                <span className="block">{option.label}</span>
                                {option.description ? (
                                  <span className="text-muted-foreground block text-xs font-normal">
                                    {option.description}
                                  </span>
                                ) : null}
                              </span>
                            </ToggleGroupItem>
                          ))}
                        </ToggleGroup>
                      ) : null}
                      <div className="space-y-1.5">
                        {/* oxlint-disable-next-line shadcn/no-restyle -- a secondary prompt under the options, not a field label */}
                        <Label htmlFor={customId} className="text-xs">
                          {question.options.length === 0
                            ? "Your answer"
                            : question.multiSelect
                              ? "Add your own answer (optional)"
                              : "Or write your own answer"}
                        </Label>
                        <Textarea
                          id={customId}
                          value={answer.custom}
                          disabled={locked}
                          maxLength={4000}
                          rows={2}
                          className="min-h-16 resize-y"
                          onChange={(event) => {
                            const custom = event.target.value;
                            setAnswers((current) =>
                              current.map((item, i) =>
                                i === index
                                  ? {
                                      custom,
                                      selected:
                                        !question.multiSelect && custom.trim() ? [] : item.selected,
                                    }
                                  : item,
                              ),
                            );
                          }}
                        />
                      </div>
                    </>
                  ) : resolvedAnswer ? (
                    <div
                      role="group"
                      aria-label="Your answers"
                      className="space-y-1 [overflow-wrap:anywhere]"
                    >
                      {resolvedAnswer.selected.map((choice) => (
                        <p key={choice} className="text-sm">
                          {question.options[choice]?.label}
                        </p>
                      ))}
                      {resolvedAnswer.custom.trim() ? (
                        <p className="whitespace-pre-wrap text-sm">
                          {resolvedAnswer.custom.trim()}
                        </p>
                      ) : null}
                    </div>
                  ) : !resolution && question.options.length > 0 ? (
                    <ul className="text-muted-foreground space-y-1 text-xs [overflow-wrap:anywhere]">
                      {question.options.map((option) => (
                        <li key={option.label}>
                          {option.label}
                          {option.description ? `: ${option.description}` : ""}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </fieldset>
              );
            })}
            {actionable || preparing ? (
              <div className="flex flex-wrap gap-2">
                <PendingButton
                  type="submit"
                  size="sm"
                  pending={pending === "answers"}
                  disabled={locked || !valid}
                >
                  {editing ? "Save answers" : "Send answers"}
                </PendingButton>
                <PendingButton
                  size="sm"
                  variant="ghost"
                  pending={pending === "skip"}
                  disabled={locked}
                  onClick={() => void submit({ kind: "skip" })}
                >
                  {editing ? "Skip and regenerate" : "Skip and continue"}
                </PendingButton>
                {editState ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={locked}
                    onClick={editState.onCancel}
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>
            ) : null}
          </form>
          {resolution && !editing ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {resolution.response.kind === "skip" ? (
                <span className="text-muted-foreground text-xs">Skipped</span>
              ) : null}
              {resolution.onEdit ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={resolution.onEdit}
                  disabled={resolution.editDisabled}
                >
                  Edit answers
                </Button>
              ) : null}
              {resolution.time ? (
                <time
                  dateTime={resolution.time.iso}
                  title={resolution.time.absolute}
                  className="text-muted-foreground text-2xs tabular-nums"
                >
                  {resolution.time.clock}
                </time>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}
