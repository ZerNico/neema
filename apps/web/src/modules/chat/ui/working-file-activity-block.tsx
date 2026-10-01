import {
  Alert02Icon,
  ArrowDown01Icon,
  Doc01Icon,
  Presentation01Icon,
  Xls01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState, type ReactNode } from "react";
import {
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  disclosureBodyRailClassName,
  disclosureChevronMotionClassName,
  disclosureTriggerClassName,
} from "~/ui/disclosure.tsx";
import { MotionSwap } from "~/ui/motion.tsx";
import { Spinner } from "~/ui/primitives/spinner";
import { cn } from "~/ui/utils";
import { OFFICE_FAMILIES, type OfficeFamily } from "~/modules/office/families.ts";
import type { OfficeActivity } from "../client/use-message-stream.ts";
import type { WorkingFilePart } from "./assistant-body.ts";

type Step = WorkingFilePart["steps"][number];
type OfficeStep = OfficeActivity;

const slides = (count: number) => `${count} ${count === 1 ? "slide" : "slides"}`;
const sheets = (count: number) => `${count} ${count === 1 ? "sheet" : "sheets"}`;
const blocks = (count: number) =>
  `${count} ${count === 1 ? "paragraph or table" : "paragraphs and tables"}`;

/**
 * One word for a working file's state wherever the transcript shows it. An
 * unpublished file after the answer ended is a draft: it may well be kept, so
 * the label says nothing about saving.
 */
export const workingFileState = (published: boolean, terminal: boolean) =>
  published ? "Published" : terminal ? "Draft" : "Working";

/** "slide 5", "slides 3–6" when consecutive, else "slides 1, 4 and 9". */
function positions(numbers: ReadonlyArray<number>) {
  if (numbers.length === 1) return `slide ${numbers[0]}`;
  const sorted = numbers.toSorted((a, b) => a - b);
  if (sorted.every((slide, index) => index === 0 || slide === sorted[index - 1]! + 1))
    return `slides ${sorted[0]}–${sorted.at(-1)}`;
  return `slides ${sorted.slice(0, -1).join(", ")} and ${sorted.at(-1)}`;
}

/**
 * How the transcript speaks about each Office editor. Everything shown comes
 * from bounded numbers and positions, never from the file's own text.
 */
const WORDING = {
  presentation: {
    icon: Presentation01Icon,
    noun: "presentation",
    inspect: OFFICE_FAMILIES.presentation.inspect,
    edit: OFFICE_FAMILIES.presentation.edit,
    reading: "Reading slides",
    editing: "Editing slides",
    creating: "Creating the deck",
    started: "Started a new deck",
    built: "Built the slides",
    edited: "Edited the slides",
    count: (step: OfficeStep) =>
      step.family === "presentation" && step.slideCount ? slides(step.slideCount) : null,
    read: (step: OfficeStep) => {
      if (step.family !== "presentation" || !step.read) return "Read presentation";
      const { read } = step;
      if (read.template)
        return read.template === "master" ? "Read slide master" : "Read slide layout";
      if (read.slides?.length) return `Read ${positions(read.slides)}`;
      return read.from === read.to
        ? `Read slide ${read.from}`
        : `Read slides ${read.from}–${read.to}`;
    },
  },
  spreadsheet: {
    icon: Xls01Icon,
    noun: "spreadsheet",
    inspect: OFFICE_FAMILIES.spreadsheet.inspect,
    edit: OFFICE_FAMILIES.spreadsheet.edit,
    reading: "Reading cells",
    editing: "Editing cells",
    creating: "Creating the workbook",
    started: "Started a new workbook",
    built: "Wrote the cells",
    edited: "Edited the cells",
    count: (step: OfficeStep) =>
      step.family === "spreadsheet" && step.sheetCount ? sheets(step.sheetCount) : null,
    read: (step: OfficeStep) => {
      if (step.family !== "spreadsheet" || !step.read) return "Read spreadsheet";
      const { sheet, range } = step.read;
      return range ? `Read ${range} on sheet ${sheet}` : `Read sheet ${sheet}`;
    },
  },
  word: {
    icon: Doc01Icon,
    noun: "document",
    inspect: OFFICE_FAMILIES.word.inspect,
    edit: OFFICE_FAMILIES.word.edit,
    reading: "Reading the document",
    editing: "Editing the document",
    creating: "Creating the document",
    started: "Started a new document",
    built: "Wrote the document",
    edited: "Edited the document",
    count: (step: OfficeStep) =>
      step.family === "word" && step.blockCount ? blocks(step.blockCount) : null,
    read: (step: OfficeStep) => {
      if (step.family !== "word" || !step.read) return "Read the document";
      const { from, blockCount } = step.read;
      return from === 0 ? "Read the document" : `Read on from block ${from} of ${blockCount}`;
    },
  },
} as const satisfies Record<OfficeFamily, unknown>;
type Wording = (typeof WORDING)[OfficeFamily];

/** `drafted`: a draft exists, or the file was read first, so an edit changes an existing one. */
function runningLabel(step: Step, drafted: boolean, words: Wording) {
  if (step.family === "tool-file") return "Publishing";
  if (step.writing) return "Writing changes";
  if (step.name === "render_presentation") return "Checking appearance";
  if (step.name === words.inspect) return words.reading;
  return drafted ? words.editing : words.creating;
}

/**
 * A failed step in reader words. The error text was written for the model
 * (operation paths, codes), so it stays out of the transcript.
 */
function failureLabel(step: Step, words?: Wording) {
  if (step.family === "tool-file") return "Couldn’t publish the file";
  if (words && step.name === words.inspect) return `Couldn’t read the ${words.noun}`;
  if (step.name === "render_presentation") return "Couldn’t check the slides";
  return "Couldn’t apply an edit";
}

function stepLabels(
  step: Step,
  fileName: string | undefined,
  drafted: boolean,
  words: Wording,
): string[] {
  if (step.status === "running") return [runningLabel(step, drafted, words)];
  if (step.status === "error") return [failureLabel(step, words)];
  if (step.family === "tool-file") return [`Published ${fileName ?? `the ${words.noun}`}`];
  if (step.name === words.inspect) return [words.read(step)];
  if (step.family === "presentation" && step.name === "render_presentation") {
    const count = step.renderedSlideIds?.length;
    return [count ? `Checked appearance of ${slides(count)}` : "Checked slide appearance"];
  }
  const labels: string[] = [];
  if (step.origin === "created") labels.push(words.started);
  if (step.origin === "opened") labels.push("Opened the file for editing");
  if (step.changes) labels.push(step.origin === "created" ? words.built : words.edited);
  if (step.family === "presentation" && step.renderedSlideIds?.length)
    labels.push("Checked slide appearance");
  if (step.family === "spreadsheet" && step.formulaErrors)
    labels.push(
      `${step.formulaErrors} ${step.formulaErrors === 1 ? "formula shows" : "formulas show"} an error`,
    );
  return labels.length ? labels : ["Made changes"];
}

/**
 * The disclosure's lines. Identical consecutive lines fold into one with a
 * count: a model reading page after page would otherwise list the same
 * sentence a dozen times.
 */
function stepRows(
  steps: ReadonlyArray<Step>,
  fileName: string | undefined,
  drafted: boolean,
  words: Wording,
) {
  const rows: Array<{ key: string; label: string; status: Step["status"]; count: number }> = [];
  for (const step of steps)
    stepLabels(step, fileName, drafted, words).forEach((label, index) => {
      const last = rows.at(-1);
      if (last && last.label === label && last.status === step.status) last.count += 1;
      else rows.push({ key: `${step.callId}:${index}`, label, status: step.status, count: 1 });
    });
  return rows;
}

/** Where this run of calls sits in its file's life, which the part alone cannot see. */
export interface WorkingFileState {
  /** The answer is still generating. */
  streaming: boolean;
  /** This part is the newest thing in the answer. */
  live: boolean;
  /** Some publish in the answer delivered this file. */
  published: boolean;
  /** No later part of the answer continues this file. */
  final: boolean;
}

/**
 * A model that narrates between rounds splits one draft into several parts, so
 * each header says what its own calls did. Only the newest part is live.
 * An unpublished draft says nothing about whether its checkpoint was saved.
 */
function settledLabel(
  part: WorkingFilePart,
  state: WorkingFileState,
  edits: boolean,
  words: Wording,
) {
  const { steps } = part;
  const Noun = words.noun[0]!.toUpperCase() + words.noun.slice(1);
  if (edits && !state.published && !state.streaming && state.final)
    return part.workingFileId === undefined ? `Couldn’t create the ${words.noun}` : `${Noun} draft`;
  const done = steps.filter((step) => step.status === "complete");
  const counted = done
    .flatMap((step) => (step.family === "tool-file" ? [] : [words.count(step)]))
    .findLast((count) => count !== null);
  const suffix = counted ? ` · ${counted}` : "";
  if (done.some((step) => step.family !== "tool-file" && step.origin === "created"))
    return `Created ${words.noun}${suffix}`;
  if (done.some((step) => step.name === words.edit)) return `Edited ${words.noun}${suffix}`;
  const checked = done.reduce(
    (total, step) =>
      total + (step.family === "presentation" ? (step.renderedSlideIds?.length ?? 0) : 0),
    0,
  );
  if (checked) return `Checked appearance of ${slides(checked)}`;
  if (done.some((step) => step.name === words.inspect)) return `Read ${words.noun}`;
  return edits ? `Couldn’t change the ${words.noun}` : `Couldn’t read the ${words.noun}`;
}

/** Whether the part changes a file, and whether one existed for its edits to change. */
const partKind = ({ workingFileId, steps }: WorkingFilePart, words: Wording) => ({
  edits: workingFileId !== undefined || steps.some((step) => step.name === words.edit),
  drafted: workingFileId !== undefined || steps.some((step) => step.name === words.inspect),
});

/**
 * Like the research row: while the draft is live the primary label holds still
 * and the step it is on (or just finished) rolls in beside it, so a quick call
 * is read as progress rather than a flash.
 */
function rowLabels(
  part: WorkingFilePart,
  state: WorkingFileState,
  edits: boolean,
  drafted: boolean,
  words: Wording,
) {
  const { steps } = part;
  const running = steps.find((step) => step.status === "running");
  // Newest in a streaming answer, the deck is still being worked on between
  // calls too: reading-only runs used to settle while the model thought, and
  // with "Thinking" held back for this row nothing then showed it was busy.
  const live = !!running || (!state.published && state.streaming && state.live);
  if (live) {
    const current = running ?? steps.at(-1)!;
    return {
      live,
      primary: edits ? `Working on ${words.noun}` : `Reading ${words.noun}`,
      secondary:
        current.status === "error"
          ? "A step failed"
          : // "Reading presentation · Reading slides" says one thing twice.
            !edits && current.name === words.inspect
            ? null
            : runningLabel(current, drafted, words),
    };
  }
  const failed = steps.filter((step) => step.status === "error").length;
  return {
    live,
    primary: settledLabel(part, state, edits, words),
    secondary:
      failed && !state.published ? `${failed} ${failed === 1 ? "step" : "steps"} failed` : null,
  };
}

/**
 * One draft's calls as a single line that states what is happening now. Steps,
 * failures included, stay one click away so the transcript does not jump as a
 * long edit loop runs. The delivered file renders beneath as its result.
 */
export function WorkingFileActivityBlock({
  part,
  state,
  children,
}: {
  part: WorkingFilePart;
  state: WorkingFileState;
  /** The delivered file, if any. */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const office = part.steps.find((step) => step.family !== "tool-file");
  // A publish of a file some other tool produced has no steps worth listing.
  if (!office) {
    const failure = part.steps.find((step) => step.status === "error");
    return (
      <>
        {failure ? (
          <p className="text-muted-foreground mb-2 flex items-center gap-1.5 text-sm">
            <HugeiconsIcon
              icon={Alert02Icon}
              strokeWidth={2}
              className="text-destructive size-4"
              aria-hidden
            />
            {failureLabel(failure)}
          </p>
        ) : null}
        {children}
      </>
    );
  }
  const fileName = part.file?.attachment.fileName;
  const words = WORDING[office.family];
  const { edits, drafted } = partKind(part, words);
  const { live, primary, secondary } = rowLabels(part, state, edits, drafted, words);
  return (
    <>
      <Disclosure open={open} onOpenChange={setOpen} className="mb-2">
        <DisclosureTrigger
          className={cn(disclosureTriggerClassName, "h-5 max-w-full min-w-0")}
          aria-busy={live || undefined}
        >
          <MotionSwap value={live ? "live" : "settled"} kind="icon" className="size-4 shrink-0">
            {live ? (
              <Spinner aria-hidden className="size-4" />
            ) : (
              <HugeiconsIcon icon={words.icon} strokeWidth={2} className="size-4" aria-hidden />
            )}
          </MotionSwap>
          <MotionSwap
            value={primary}
            kind="rolling-text"
            className={cn("min-w-0", live && "shrink-0")}
          >
            <span className={cn(live && "text-shimmer font-medium")}>{primary}</span>
          </MotionSwap>
          {secondary ? (
            <>
              <span className="text-muted-foreground/40 shrink-0" aria-hidden>
                ·
              </span>
              <MotionSwap value={secondary} kind="rolling-text" className="min-w-0 truncate">
                {secondary}
              </MotionSwap>
            </>
          ) : null}
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            strokeWidth={2}
            className={cn(
              disclosureChevronMotionClassName,
              "size-3.5 shrink-0",
              open && "rotate-180",
            )}
            aria-hidden
          />
        </DisclosureTrigger>
        <DisclosureContent>
          <ol className={cn(disclosureBodyRailClassName, "flex flex-col gap-1.5")}>
            {stepRows(part.steps, fileName, drafted, words).map((row) => (
              <li key={row.key} className="flex items-start gap-1.5">
                {row.status === "error" ? (
                  <HugeiconsIcon
                    icon={Alert02Icon}
                    strokeWidth={2}
                    className="text-destructive mt-0.5 size-3.5 shrink-0"
                    aria-label="Failed"
                  />
                ) : null}
                <span className={cn("min-w-0", row.status === "running" && "text-shimmer")}>
                  {row.count > 1 ? `${row.label} · ${row.count} times` : row.label}
                </span>
              </li>
            ))}
          </ol>
        </DisclosureContent>
      </Disclosure>
      {children}
    </>
  );
}
