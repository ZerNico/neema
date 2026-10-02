import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState, type ReactNode } from "react";
import { isBrowserTool } from "~/modules/browser/tool-schema.ts";
import {
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  disclosureBodyRailClassName,
  disclosureChevronMotionClassName,
  disclosureTriggerClassName,
} from "~/ui/disclosure.tsx";
import { cn } from "~/ui/utils";
import type { ToolActivity } from "../client/use-message-stream.ts";
import type { WorkPart, WorkStep } from "./assistant-body.ts";
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
      return step.activities.some((call) => call.name === "read_url" && call.status === "running")
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

const pastLabel = (step: WorkStep) => {
  const present = stepLabel(step);
  return (
    PAST[present] ??
    present
      .replace(/^Using /, "Used ")
      .replace(/^Running /, "Ran ")
      .replace(/^Working$/, "Worked")
  );
};

/** "Searched the web, read a file and ran a command": each kind of step once, in order. */
export const workSummary = (steps: ReadonlyArray<WorkStep>) => {
  const labels = [...new Set(steps.map(pastLabel))];
  const shown = labels
    .slice(0, 3)
    .map((label, index) => (index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1)));
  if (labels.length > 3) return `${shown.join(", ")} and more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : shown[0]!;
};

export const formatDuration = (ms: number) => {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
};

/** Wall time from the first call's start to the last one's end, when the calls say. */
export const workSpan = (steps: ReadonlyArray<WorkStep>) => {
  const calls = steps.flatMap(stepActivities);
  const starts = calls.flatMap((call) => (call.startedAt ? [call.startedAt] : []));
  if (!starts.length) return null;
  const ends = calls.flatMap((call) => [call.completedAt ?? call.startedAt ?? 0]);
  return { start: Math.min(...starts), end: Math.max(...ends) };
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
 * answer it stays open, its header naming the current step with a running
 * clock; once the answer moves on it folds into "Worked for 42s".
 */
export function WorkGroupBlock({
  part,
  live,
  renderStep,
}: {
  part: WorkPart;
  /** The newest part of a streaming answer. */
  live: boolean;
  renderStep: (step: WorkStep, live: boolean) => ReactNode;
}) {
  const calls = part.steps.flatMap(stepActivities);
  const running = live || calls.some((call) => call.status === "running");
  const { expanded, onOpenChange } = useRunDisclosure(running);
  const span = workSpan(part.steps);
  // Reasoning alone has no recorded start; the clock then starts when this
  // row first appears, which is when the work became visible.
  const [mountedAt] = useState(() => Date.now());
  const elapsed = useElapsed(span?.start ?? mountedAt, running);
  const failed = calls.filter((call) => call.status === "error").length;
  const current = part.steps.at(-1)!;

  const label = running
    ? `${stepLabel(current)} · ${formatDuration(elapsed)}`
    : span && span.end - span.start >= 1000
      ? `Worked for ${formatDuration(span.end - span.start)}`
      : workSummary(part.steps);

  return (
    <Disclosure open={expanded} onOpenChange={onOpenChange} className="mb-2">
      <DisclosureTrigger className={disclosureTriggerClassName}>
        <span className={cn(running && "text-shimmer")}>{label}</span>
        {failed > 0 ? (
          <span className="text-destructive">
            · {failed === 1 ? "1 failed" : `${failed} failed`}
          </span>
        ) : null}
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          strokeWidth={2}
          className={cn(disclosureChevronMotionClassName, "size-3.5", expanded && "rotate-180")}
          aria-hidden
        />
      </DisclosureTrigger>
      <DisclosureContent>
        <div className={cn(disclosureBodyRailClassName, "flex flex-col")}>
          {part.steps.map((step, index) =>
            renderStep(step, live && index === part.steps.length - 1),
          )}
        </div>
      </DisclosureContent>
    </Disclosure>
  );
}
