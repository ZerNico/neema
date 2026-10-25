import { m } from "~/paraglide/messages.js";
import {
  Alert02Icon,
  Doc01Icon,
  File01Icon,
  Presentation01Icon,
  Xls01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { Disclosure, DisclosureContent, DisclosureTrigger } from "~/ui/disclosure.tsx";
import {
  disclosureBodyRailClassName,
  disclosureTriggerClassName,
} from "~/ui/disclosure-classes.ts";
import { cn } from "~/ui/utils";
import { OFFICE_FAMILIES, type OfficeFamily } from "~/modules/office/families.ts";
import type { OfficeActivity } from "../client/use-message-stream.ts";
import { ActivityChevron, ActivityFace } from "./activity-face.tsx";
import { activityRowClassName } from "./activity-row.ts";
import type { WorkingFilePart } from "./assistant-body.ts";

type Step = WorkingFilePart["steps"][number];
type OfficeStep = OfficeActivity;

const slides = (count: number) => m.chat_office_slides({ count });

/** "Read slide 5", "Read slides 3–6" when consecutive, else "Read slides 1, 4 and 9". */
function readPositions(numbers: ReadonlyArray<number>) {
  if (numbers.length === 1) return m.chat_office_read_slide({ number: numbers[0]! });
  const sorted = numbers.toSorted((a, b) => a - b);
  if (sorted.every((slide, index) => index === 0 || slide === sorted[index - 1]! + 1))
    return m.chat_office_read_slide_range({ from: sorted[0]!, to: sorted.at(-1)! });
  return m.chat_office_read_slide_list({
    list: sorted.slice(0, -1).join(", "),
    last: sorted.at(-1)!,
  });
}

/**
 * How the transcript speaks about each Office editor. Everything shown comes
 * from bounded numbers and positions, never from the file's own text. Each
 * family has its own sentences, since its noun's gender changes the German.
 */
const WORDING = {
  presentation: {
    icon: Presentation01Icon,
    inspect: OFFICE_FAMILIES.presentation.inspect,
    edit: OFFICE_FAMILIES.presentation.edit,
    reading: m.chat_office_presentation_reading,
    editing: m.chat_office_presentation_editing,
    creating: m.chat_office_presentation_creating,
    started: m.chat_office_presentation_started,
    built: m.chat_office_presentation_built,
    edited: m.chat_office_presentation_edited,
    working: m.chat_office_presentation_working,
    readingFile: m.chat_office_presentation_reading_file,
    created: m.chat_office_presentation_created,
    changed: m.chat_office_presentation_changed,
    readFile: m.chat_office_presentation_read,
    draft: m.chat_office_presentation_draft,
    createFailed: m.chat_office_presentation_create_failed,
    changeFailed: m.chat_office_presentation_change_failed,
    readFailed: m.chat_office_presentation_read_failed,
    createdFile: m.chat_office_presentation_created_file,
    publishedFile: m.chat_office_presentation_published_file,
    count: (step: OfficeStep) =>
      step.family === "presentation" && step.slideCount ? slides(step.slideCount) : null,
    read: (step: OfficeStep) => {
      if (step.family !== "presentation" || !step.read) return m.chat_office_presentation_read();
      const { read } = step;
      if (read.template)
        return read.template === "master"
          ? m.chat_office_read_slide_master()
          : m.chat_office_read_slide_layout();
      if (read.slides?.length) return readPositions(read.slides);
      return read.from === read.to
        ? m.chat_office_read_slide({ number: read.from })
        : m.chat_office_read_slide_range({ from: read.from, to: read.to });
    },
  },
  spreadsheet: {
    icon: Xls01Icon,
    inspect: OFFICE_FAMILIES.spreadsheet.inspect,
    edit: OFFICE_FAMILIES.spreadsheet.edit,
    reading: m.chat_office_spreadsheet_reading,
    editing: m.chat_office_spreadsheet_editing,
    creating: m.chat_office_spreadsheet_creating,
    started: m.chat_office_spreadsheet_started,
    built: m.chat_office_spreadsheet_built,
    edited: m.chat_office_spreadsheet_edited,
    working: m.chat_office_spreadsheet_working,
    readingFile: m.chat_office_spreadsheet_reading_file,
    created: m.chat_office_spreadsheet_created,
    changed: m.chat_office_spreadsheet_changed,
    readFile: m.chat_office_spreadsheet_read,
    draft: m.chat_office_spreadsheet_draft,
    createFailed: m.chat_office_spreadsheet_create_failed,
    changeFailed: m.chat_office_spreadsheet_change_failed,
    readFailed: m.chat_office_spreadsheet_read_failed,
    createdFile: m.chat_office_spreadsheet_created_file,
    publishedFile: m.chat_office_spreadsheet_published_file,
    count: (step: OfficeStep) =>
      step.family === "spreadsheet" && step.sheetCount
        ? m.chat_office_sheets({ count: step.sheetCount })
        : null,
    read: (step: OfficeStep) => {
      if (step.family !== "spreadsheet" || !step.read) return m.chat_office_spreadsheet_read();
      const { sheet, range } = step.read;
      return range
        ? m.chat_office_read_range({ range, sheet })
        : m.chat_office_read_sheet({ sheet });
    },
  },
  word: {
    icon: Doc01Icon,
    inspect: OFFICE_FAMILIES.word.inspect,
    edit: OFFICE_FAMILIES.word.edit,
    reading: m.chat_office_word_reading,
    editing: m.chat_office_word_editing,
    creating: m.chat_office_word_creating,
    started: m.chat_office_word_started,
    built: m.chat_office_word_built,
    edited: m.chat_office_word_edited,
    working: m.chat_office_word_working,
    readingFile: m.chat_office_word_reading_file,
    created: m.chat_office_word_created,
    changed: m.chat_office_word_changed,
    readFile: m.chat_office_word_read_settled,
    draft: m.chat_office_word_draft,
    createFailed: m.chat_office_word_create_failed,
    changeFailed: m.chat_office_word_change_failed,
    readFailed: m.chat_office_word_read_failed,
    createdFile: m.chat_office_word_created_file,
    publishedFile: m.chat_office_word_published_file,
    count: (step: OfficeStep) =>
      step.family === "word" && step.blockCount
        ? m.chat_office_blocks({ count: step.blockCount })
        : null,
    read: (step: OfficeStep) => {
      if (step.family !== "word" || !step.read) return m.chat_office_word_read();
      const { from, blockCount } = step.read;
      return from === 0
        ? m.chat_office_word_read()
        : m.chat_office_word_read_on({ from, total: blockCount });
    },
  },
} as const satisfies Record<OfficeFamily, unknown>;
type Wording = (typeof WORDING)[OfficeFamily];

/** `drafted`: a draft exists, or the file was read first, so an edit changes an existing one. */
function runningLabel(step: Step, drafted: boolean, words: Wording) {
  if (step.family === "tool-file")
    return step.name === "create_file" ? m.chat_office_writing_file() : m.chat_office_publishing();
  if (step.writing) return m.chat_office_writing_changes();
  if (step.name === "render_presentation") return m.chat_office_checking_appearance();
  if (step.name === words.inspect) return words.reading();
  return drafted ? words.editing() : words.creating();
}

/**
 * A failed step in reader words. The error text was written for the model
 * (operation paths, codes), so it stays out of the transcript.
 */
function failureLabel(step: Step, words?: Wording) {
  if (step.family === "tool-file")
    return step.name === "create_file"
      ? m.chat_office_create_file_failed()
      : m.chat_office_publish_file_failed();
  if (words && step.name === words.inspect) return words.readFailed();
  if (step.name === "render_presentation") return m.chat_office_check_slides_failed();
  return m.chat_office_edit_failed();
}

function stepLabels(
  step: Step,
  fileName: string | undefined,
  drafted: boolean,
  words: Wording,
): string[] {
  if (step.status === "running") return [runningLabel(step, drafted, words)];
  if (step.status === "error") return [failureLabel(step, words)];
  if (step.family === "tool-file") {
    const created = step.name === "create_file";
    if (fileName)
      return [
        created
          ? m.chat_office_created_named({ name: fileName })
          : m.chat_office_published_named({ name: fileName }),
      ];
    return [created ? words.createdFile() : words.publishedFile()];
  }
  if (step.name === words.inspect) return [words.read(step)];
  if (step.family === "presentation" && step.name === "render_presentation") {
    const count = step.renderedSlideIds?.length;
    return [count ? m.chat_office_checked_appearance({ count }) : m.chat_office_checked_slides()];
  }
  const labels: string[] = [];
  if (step.origin === "created") labels.push(words.started());
  if (step.origin === "opened") labels.push(m.chat_office_opened_for_editing());
  if (step.changes) labels.push(step.origin === "created" ? words.built() : words.edited());
  if (step.family === "presentation" && step.renderedSlideIds?.length)
    labels.push(m.chat_office_checked_slides());
  if (step.family === "spreadsheet" && step.formulaErrors)
    labels.push(m.chat_office_formula_errors({ count: step.formulaErrors }));
  return labels.length ? labels : [m.chat_office_made_changes()];
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
  if (edits && !state.published && !state.streaming && state.final)
    return part.workingFileId === undefined ? words.createFailed() : words.draft();
  const done = steps.filter((step) => step.status === "complete");
  const counted = done
    .flatMap((step) => (step.family === "tool-file" ? [] : [words.count(step)]))
    .findLast((count) => count !== null);
  const withCount = (label: string) => (counted ? `${label} · ${counted}` : label);
  if (done.some((step) => step.family !== "tool-file" && step.origin === "created"))
    return withCount(words.created());
  if (done.some((step) => step.name === words.edit)) return withCount(words.changed());
  const checked = done.reduce(
    (total, step) =>
      total + (step.family === "presentation" ? (step.renderedSlideIds?.length ?? 0) : 0),
    0,
  );
  if (checked) return m.chat_office_checked_appearance({ count: checked });
  if (done.some((step) => step.name === words.inspect)) return words.readFile();
  return edits ? words.changeFailed() : words.readFailed();
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
      primary: edits ? words.working() : words.readingFile(),
      // A failed step is the model's to retry, not news for the reader: the
      // line keeps naming the work, and the step list marks the failure.
      secondary:
        // "Reading presentation · Reading slides" says one thing twice.
        !edits && current.name === words.inspect ? null : runningLabel(current, drafted, words),
    };
  }
  return { live, primary: settledLabel(part, state, edits, words), secondary: null };
}

/**
 * One draft's calls as a single line that states what is happening now. Steps,
 * failures included, stay one click away so the transcript does not jump as a
 * long edit loop runs. The delivered file is its own part, after the work line.
 */
export function WorkingFileActivityBlock({
  part,
  state,
}: {
  part: WorkingFilePart;
  state: WorkingFileState;
}) {
  const [open, setOpen] = useState(false);
  const office = part.steps.find((step) => step.family !== "tool-file");
  // A publish of a file some other tool produced has no steps worth listing.
  if (!office) {
    const failure = part.steps.find((step) => step.status === "error");
    return (
      <div className={cn(activityRowClassName, "mb-2")}>
        {failure ? (
          <ActivityFace label={failureLabel(failure)} status="failed" />
        ) : (
          <ActivityFace
            icon={File01Icon}
            label={m.chat_office_publishing_file()}
            status="running"
          />
        )}
      </div>
    );
  }
  const fileName = part.files.at(-1)?.attachment.fileName;
  const words = WORDING[office.family];
  const { edits, drafted } = partKind(part, words);
  const { live, primary, secondary } = rowLabels(part, state, edits, drafted, words);
  const failed = !live && part.steps.every((step) => step.status === "error");
  return (
    <>
      <Disclosure open={open} onOpenChange={setOpen} className="mb-2">
        <DisclosureTrigger className={disclosureTriggerClassName} aria-busy={live || undefined}>
          <ActivityFace
            icon={words.icon}
            label={primary}
            // "Couldn’t read the presentation · 1 step failed" says it twice.
            detail={failed ? null : secondary}
            status={live ? "running" : failed ? "failed" : "done"}
          />
          <ActivityChevron open={open} />
        </DisclosureTrigger>
        <DisclosureContent>
          <ol className={cn(disclosureBodyRailClassName, "flex flex-col gap-1.5")}>
            {stepRows(part.steps, fileName, drafted, words).map((row) => (
              <li key={row.key} className="flex items-start gap-1.5">
                {row.status === "error" ? (
                  <HugeiconsIcon
                    icon={Alert02Icon}
                    strokeWidth={2}
                    className="text-warning mt-0.5 size-3.5 shrink-0"
                    aria-label={m.chat_office_failed()}
                  />
                ) : null}
                <span className={cn("min-w-0", row.status === "running" && "text-shimmer")}>
                  {row.count > 1
                    ? m.chat_office_times({ label: row.label, count: row.count })
                    : row.label}
                </span>
              </li>
            ))}
          </ol>
        </DisclosureContent>
      </Disclosure>
    </>
  );
}
