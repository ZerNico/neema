import { m } from "~/paraglide/messages.js";
import {
  ArrowLeft01Icon,
  ArrowRight02Icon,
  ArrowUp02Icon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  formatQuestionResponse,
  type AskUserQuestion,
  type QuestionResponse,
} from "~/modules/tools/ask-user-schema.ts";
import { HeightMorph, MotionSwap } from "~/ui/motion.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Button } from "~/ui/primitives/button";
import { Kbd } from "~/ui/primitives/kbd";
import { Spinner } from "~/ui/primitives/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { ToggleGroup, ToggleGroupItem } from "~/ui/primitives/toggle-group";
import { cn } from "~/ui/utils";
import * as motion from "motion/react-m";
import { stepMotion } from "~/ui/motion-presets.ts";
import type { AskToolActivity } from "../client/use-message-stream.ts";
import { focusIsLost } from "./focus-lost.ts";

type Answer = { selected: number[]; custom: string };

const answered = (question: AskUserQuestion, answer: Answer) =>
  formatQuestionResponse([question], { kind: "answers", answers: [answer] }) !== null;

// Keys that would also type into a field leave it alone.
const typing = (target: EventTarget) =>
  target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement;

/**
 * Open questions as what the composer turns into, one at a time: the choices
 * where the draft was, a field for an own answer where one types, and Next or
 * Send as the composer's round button. The answer is its own submission, so
 * nothing the composer holds (toggles, files) can reach it. Dismissing only
 * hands the composer back: the question stays open, and a plain message
 * answers past it.
 */
export function QuestionDock({
  activity,
  onRespond,
  onDismiss,
  disabled,
  actions,
  open = true,
}: {
  activity: AskToolActivity;
  /** Rejects on failure, and every choice stays for another try. */
  onRespond: (callId: string, response: QuestionResponse) => Promise<unknown>;
  onDismiss: () => void;
  disabled: boolean;
  /** The composer bar's slot beside Stop; without one the buttons sit below. */
  actions: HTMLElement | null;
  /** False while put aside; it stays mounted, so its choices survive being reopened. */
  open?: boolean;
}) {
  const id = useId();
  const questions = activity.questions ?? [];
  const [answers, setAnswers] = useState<Answer[]>(() =>
    questions.map(() => ({ selected: [], custom: "" })),
  );
  // Which way the reader last went, so the next question slides in from that side.
  // The first question arrives with the composer's own swap; only later ones slide.
  const [{ step, direction, moved }, setPlace] = useState({ step: 0, direction: 1, moved: false });
  const setStep = (next: number) =>
    setPlace({ step: next, direction: next > step ? 1 : -1, moved: true });
  const [pending, setPending] = useState<QuestionResponse["kind"] | null>(null);
  // Answered: the question leaves with the next refetch, and nothing may answer it again.
  const [submitted, setSubmitted] = useState(false);
  const submitting = useRef(false);
  const section = useRef<HTMLElement>(null);

  // Covering the composer took the caret with it: give the keys somewhere to go,
  // unless the reader had already moved on to something else on the page.
  useEffect(() => {
    if (open && focusIsLost()) section.current?.focus({ preventScroll: true });
  }, [open]);

  const question = questions[step];
  const answer = answers[step];
  if (!question || !answer) return null;
  const last = step === questions.length - 1;
  const locked = disabled || submitted || pending !== null;
  const ready = answered(question, answer);

  const update = (next: Partial<Answer>) =>
    setAnswers((current) =>
      current.map((item, index) => (index === step ? { ...item, ...next } : item)),
    );

  const submit = async (value: QuestionResponse) => {
    if (locked || submitting.current) return;
    if (formatQuestionResponse(questions, value) === null) return;
    submitting.current = true;
    setPending(value.kind);
    try {
      await onRespond(activity.callId, value);
      setSubmitted(true);
    } catch {
      // The view owns the toast and the refetch; the answers stay as they were.
    } finally {
      submitting.current = false;
      setPending(null);
    }
  };

  const advance = () => {
    if (locked || !ready) return;
    if (last) void submit({ kind: "answers", answers });
    else setStep(step + 1);
  };

  const choose = (selected: number[]) => {
    update({
      selected,
      custom: !question.multiSelect && selected.length > 0 ? "" : answer.custom,
    });
    // A single choice answers the question: move on, but never send by itself.
    if (!question.multiSelect && selected.length === 1 && !last) setStep(step + 1);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onDismiss();
      return;
    }
    if (typing(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
    const choice = Number(event.key) - 1;
    if (Number.isInteger(choice) && choice >= 0 && choice < question.options.length) {
      event.preventDefault();
      if (locked) return;
      const has = answer.selected.includes(choice);
      choose(
        question.multiSelect
          ? has
            ? answer.selected.filter((value) => value !== choice)
            : [...answer.selected, choice].toSorted((a, b) => a - b)
          : [choice],
      );
    } else if (event.key === "Enter" && event.target === event.currentTarget) {
      event.preventDefault();
      advance();
    }
  };

  const questionId = `${id}-question-${step}`;
  const customLabel =
    question.options.length === 0
      ? m.chat_ask_your_answer()
      : question.multiSelect
        ? m.chat_ask_add_own()
        : m.chat_ask_write_own();
  const submitLabel = last ? m.chat_ask_send() : m.chat_ask_next();
  const buttons = (
    <>
      {step > 0 ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending !== null}
          onClick={() => setStep(step - 1)}
          className="text-muted-foreground"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} data-icon="inline-start" />
          {m.common_back()}
        </Button>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-sm"
              onClick={advance}
              disabled={locked || !ready}
              aria-label={submitLabel}
              aria-busy={pending === "answers" || undefined}
            />
          }
        >
          <MotionSwap
            value={pending === "answers" ? "pending" : last ? "send" : "next"}
            kind="icon"
            className="size-4"
          >
            {pending === "answers" ? (
              <Spinner aria-hidden className="size-4" />
            ) : (
              <HugeiconsIcon
                icon={last ? ArrowUp02Icon : ArrowRight02Icon}
                strokeWidth={2}
                className="size-4"
                aria-hidden
              />
            )}
          </MotionSwap>
        </TooltipTrigger>
        <TooltipContent>
          {submitLabel}
          <Kbd>Enter</Kbd>
        </TooltipContent>
      </Tooltip>
    </>
  );
  return (
    <section
      ref={section}
      tabIndex={-1}
      aria-label={m.chat_ask_label()}
      aria-busy={pending !== null || undefined}
      onKeyDown={onKeyDown}
      className="flex max-h-[min(34rem,60dvh)] min-w-0 flex-col gap-3 overflow-x-hidden overflow-y-auto px-4 pt-3.5 outline-none"
    >
      <div className="text-muted-foreground -mr-2 flex min-h-6 min-w-0 items-center gap-2 text-xs">
        {questions.length > 1 ? (
          <>
            <span className="flex gap-1" aria-hidden>
              {questions.map((item, index) => (
                <span
                  key={item.question}
                  className={cn(
                    "h-1 w-4 rounded-full transition-colors duration-300",
                    index <= step ? "bg-foreground/70" : "bg-foreground/10",
                  )}
                />
              ))}
            </span>
            <span className="tabular-nums">
              {m.chat_ask_position({ index: step + 1, count: questions.length })}
            </span>
          </>
        ) : question.header ? (
          <span>{question.header}</span>
        ) : null}
        <span className="flex-1" />
        <PendingButton
          size="xs"
          variant="ghost"
          pending={pending === "skip"}
          disabled={locked}
          onClick={() => void submit({ kind: "skip" })}
          className="text-muted-foreground"
        >
          {m.chat_ask_skip_continue()}
        </PendingButton>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={m.chat_ask_dismiss()}
                onClick={onDismiss}
                className="text-muted-foreground"
              />
            }
          >
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
          </TooltipTrigger>
          <TooltipContent>
            {m.chat_ask_dismiss()}
            <Kbd>Esc</Kbd>
          </TooltipContent>
        </Tooltip>
      </div>
      <form
        className="min-w-0"
        onSubmit={(event) => {
          event.preventDefault();
          advance();
        }}
      >
        <HeightMorph swap={step}>
          <motion.fieldset
            key={step}
            {...(moved ? stepMotion(direction) : {})}
            disabled={locked}
            className="flex min-w-0 flex-col gap-2"
          >
            <legend
              id={questionId}
              className="mb-1 text-base font-medium text-balance [overflow-wrap:anywhere]"
            >
              {questions.length > 1 && question.header ? (
                <span className="text-muted-foreground mb-0.5 block text-xs font-normal">
                  {question.header}
                </span>
              ) : null}
              {question.question}
            </legend>
            {question.options.length > 0 ? (
              <ToggleGroup
                aria-labelledby={questionId}
                multiple={question.multiSelect}
                orientation="vertical"
                spacing={1}
                value={answer.selected.map(String)}
                disabled={locked}
                className="-mx-2 w-[calc(100%+1rem)]"
                onValueChange={(values) => choose(values.map(Number))}
              >
                {question.options.map((option, choice) => (
                  <ToggleGroupItem
                    key={option.label}
                    value={String(choice)}
                    aria-label={option.label}
                    // oxlint-disable-next-line shadcn/no-restyle -- a choice is a full-width numbered row with a label and an optional description, wrapping to as many lines as it needs
                    className="group/choice hover:bg-muted aria-pressed:bg-muted h-auto min-h-11 w-full justify-start gap-3 rounded-xl px-2 py-2 text-left font-normal whitespace-normal"
                  >
                    <kbd
                      aria-hidden
                      className="text-muted-foreground group-aria-pressed/choice:bg-foreground group-aria-pressed/choice:text-background group-aria-pressed/choice:border-foreground grid size-6 shrink-0 place-items-center self-start rounded-lg border font-mono text-xs transition-colors"
                    >
                      {choice + 1}
                    </kbd>
                    <span className="min-w-0 self-center [overflow-wrap:anywhere]">
                      <span className="block text-sm">{option.label}</span>
                      {option.description ? (
                        <span className="text-muted-foreground block text-xs">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            ) : null}
            {/* Where one would type in the composer, and looking like it. */}
            <textarea
              aria-label={customLabel}
              placeholder={customLabel}
              value={answer.custom}
              disabled={locked}
              maxLength={4000}
              rows={1}
              className={cn(
                "placeholder:text-muted-foreground max-h-40 min-h-10 w-full resize-none bg-transparent py-2 text-base outline-none [field-sizing:content] disabled:opacity-50 md:text-sm",
                question.options.length > 0 && "border-t pt-3",
              )}
              onChange={(event) => {
                const custom = event.target.value;
                update({
                  custom,
                  selected: !question.multiSelect && custom.trim() ? [] : answer.selected,
                });
              }}
              onKeyDown={(event) => {
                // Enter moves on as in the composer; Shift+Enter is a new line.
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  advance();
                }
              }}
            />
          </motion.fieldset>
        </HeightMorph>
      </form>
      {actions ? (
        createPortal(buttons, actions)
      ) : (
        <div className="flex justify-end gap-1 pb-2">{buttons}</div>
      )}
    </section>
  );
}
