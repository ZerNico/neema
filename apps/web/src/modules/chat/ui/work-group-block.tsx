import { useEffect, useState, type ReactNode } from "react";
import { isBrowserTool } from "~/modules/browser/tool-schema.ts";
import {
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  disclosureTriggerClassName,
} from "~/ui/disclosure.tsx";
import { cn } from "~/ui/utils";
import type { ToolActivity } from "../client/use-message-stream.ts";
import type { WorkPart, WorkStep } from "./assistant-body.ts";
import { ActivityChevron } from "./activity-face.tsx";
import { useRunDisclosure } from "./use-run-disclosure.ts";

/** The calls behind a step, for timing, failures and what is running. */
export const stepActivities = (step: WorkStep): ToolActivity[] => {
  switch (step.kind) {
    case "web":
    case "skill":
    case "knowledge":
    case "browser":
      return step.activities;
    case "tool":
      return [step.activity];
    default:
      return [];
  }
};

/** What a step is doing, in the present tense, for the live header. */
export function stepLabel(step: WorkStep): string {
  switch (step.kind) {
    case "reasoning":
      return "Thinking";
    case "web":
      return step.activities.some(
        (call) => call.name === "read_url" && call.status === "running",
      ) || step.activities.every((call) => call.name === "read_url")
        ? "Reading pages"
        : "Searching the web";
    case "knowledge":
      return "Searching documents";
    case "skill":
      return "Reading a skill";
    case "browser":
      return "Using the browser";
    case "compaction":
      return "Summarizing earlier messages";
    case "tool": {
      const call = step.activity;
      switch (call.family) {
        case "integration":
          return `Using ${call.label}`;
        case "custom":
          return `Running ${call.displayName}`;
        case "project-file":
          return "Working with project files";
        case "attachment":
          return "Reading a file";
        case "desktop":
          if (isBrowserTool(call.name)) return "Using the browser";
          if (call.name === "run_command") return "Running a command";
          if (
            call.name === "write_local_file" ||
            call.name === "edit_local_file" ||
            call.name === "move_local_file" ||
            call.name === "delete_local_file"
          )
            return "Editing files";
          return "Looking through files";
        default:
          return "Working";
      }
    }
    default:
      return "Working";
  }
}

/** What a settled step did, in the past tense, for a group without timing. */
const PAST: Record<string, string> = {
  Thinking: "Thought",
  "Reading pages": "Read pages",
  "Searching the web": "Searched the web",
  "Searching documents": "Searched documents",
  "Reading a skill": "Read a skill",
  "Using the browser": "Used the browser",
  "Summarizing earlier messages": "Summarized earlier messages",
  "Working with project files": "Worked with project files",
  "Reading a file": "Read a file",
  "Running a command": "Ran a command",
  "Editing files": "Edited files",
  "Looking through files": "Looked through files",
};

const pastLabels = (step: WorkStep): string[] => {
  if (step.kind === "web") {
    const searched = step.activities.some((call) => call.name !== "read_url");
    const pages = new Set(
      step.activities.flatMap((call) => (call.name === "read_url" ? call.targets : [])),
    ).size;
    const read = pages === 0 ? [] : [pages === 1 ? "Read a page" : `Read ${pages} pages`];
    return searched ? ["Searched the web", ...read] : read;
  }
  const present = stepLabel(step);
  return [
    PAST[present] ??
      present
        .replace(/^Using /, "Used ")
        .replace(/^Running /, "Ran ")
        .replace(/^Working$/, "Worked"),
  ];
};

/**
 * "Searched the web, read 2 pages and ran a command": each kind of step once,
 * in order. Thinking is named only when it is all there was.
 */
export const workSummary = (steps: ReadonlyArray<WorkStep>) => {
  const acting = steps.filter((step) => step.kind !== "reasoning");
  const labels = [...new Set((acting.length ? acting : steps).flatMap(pastLabels))];
  if (labels.length === 0) return "Worked";
  const shown = labels
    .slice(0, 3)
    .map((label, index) => (index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1)));
  if (labels.length > 3) return `${shown.join(", ")} and more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : shown[0]!;
};

const formatDuration = (ms: number) => {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
};

/** When the first call started, if the calls say. */
const workStart = (steps: ReadonlyArray<WorkStep>) => {
  const starts = steps.flatMap(stepActivities).flatMap((call) => call.startedAt ?? []);
  return starts.length ? Math.min(...starts) : undefined;
};

/** A clock that ticks once a second while `running`; elapsed from `since`. */
function useElapsed(since: number, running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return Math.max(0, now - since);
}

/**
 * One line for a run of work. While it is the newest part of a streaming
 * answer it stays open, its header saying "Working" with a running clock while
 * the steps below name the detail; once the answer moves on it folds into what
 * it did, "Searched the web and read 2 pages".
 */
export function WorkGroupBlock({
  part,
  live,
  renderStep,
}: {
  part: WorkPart;
  /** The newest part of a streaming answer. */
  live: boolean;
  renderStep: (step: WorkStep) => ReactNode;
}) {
  const calls = part.steps.flatMap(stepActivities);
  const running = live || calls.some((call) => call.status === "running");
  const { expanded, onOpenChange } = useRunDisclosure(running);
  // Reasoning alone has no recorded start; the clock then starts when this
  // row first appears, which is when the work became visible.
  const [mountedAt] = useState(() => Date.now());
  const elapsed = useElapsed(workStart(part.steps) ?? mountedAt, running);
  const failed = calls.filter((call) => call.status === "error").length;

  // Live, the steps below name the detail and the header only that it is busy
  // and for how long: "Thinking" between calls read as stalled. Settled, it says
  // what was done, not how long, since the time spent thinking is not recorded.
  const label = running ? `Working · ${formatDuration(elapsed)}` : workSummary(part.steps);

  return (
    <Disclosure open={expanded} onOpenChange={onOpenChange} className="mb-2">
      <DisclosureTrigger className={disclosureTriggerClassName}>
        <span className={cn("min-w-0 truncate", running && "text-shimmer")}>{label}</span>
        {/* Counted, not alarming: a read the model worked around is no failure of the answer. */}
        {failed > 0 ? (
          <span className="shrink-0">· {failed === 1 ? "1 failed" : `${failed} failed`}</span>
        ) : null}
        <ActivityChevron open={expanded} />
      </DisclosureTrigger>
      <DisclosureContent>
        {/* Flush, not railed: each step row draws its own rail, and a second one
            around them nested two borders where ChatGPT shows a plain list. */}
        <div className="mt-2 flex flex-col">{part.steps.map((step) => renderStep(step))}</div>
      </DisclosureContent>
    </Disclosure>
  );
}
