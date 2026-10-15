import { isBrowserTool } from "~/modules/browser/tool-schema.ts";
import type { ToolActivity } from "../client/use-message-stream.ts";
import type { WorkStep } from "./assistant-body.ts";
import { documentRunLabel, documentRunSucceeded } from "./document-activity-label.ts";

/** The calls behind a step, for timing, failures and what is running. */
export const stepActivities = (step: WorkStep): ToolActivity[] => {
  switch (step.kind) {
    case "web":
    case "skill":
    case "knowledge":
    case "browser":
    case "document":
      return step.activities;
    case "working-file":
      return step.steps;
    case "tool":
      return [step.activity];
    default:
      return [];
  }
};

const OFFICE_NOUN = { presentation: "presentation", spreadsheet: "spreadsheet", word: "document" };

/** The Office family a draft step edits; a publish-only step has none. */
const officeNoun = (step: Extract<WorkStep, { kind: "working-file" }>) => {
  const office = step.steps.find((call) => call.family !== "tool-file");
  return office ? OFFICE_NOUN[office.family] : null;
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
    case "document":
      return documentRunLabel(step.activities, step.named ?? false);
    case "working-file": {
      const noun = officeNoun(step);
      return noun ? `Working on the ${noun}` : "Publishing the file";
    }
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
        case "map":
          return "Looking up a route";
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
          if (call.name.startsWith("request_")) return "Asking for access";
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
  "Looking up a route": "Looked up a route",
  "Running a command": "Ran a command",
  "Editing files": "Edited files",
  "Looking through files": "Looked through files",
  "Asking for access": "Asked for access",
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
  if (step.kind === "working-file") {
    const noun = officeNoun(step);
    if (!noun) return ["Published a file"];
    const done = step.steps.filter((call) => call.status === "complete");
    if (done.some((call) => call.family !== "tool-file" && call.origin === "created"))
      return [`Created the ${noun}`];
    if (done.some((call) => call.name.startsWith("edit_"))) return [`Edited the ${noun}`];
    return [`Read the ${noun}`];
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

/** A document step none of whose calls succeeded; its own row says so. */
const failedDocumentStep = (step: WorkStep) =>
  step.kind === "document" &&
  step.activities.every((call) => call.status !== "running") &&
  !documentRunSucceeded(step.activities);

/**
 * "Searched the web, read 2 pages and ran a command": each kind of step once,
 * in order. Thinking is named only when it is all there was, and a failed
 * document step only when nothing else was done: a retry is not news.
 */
export const workSummary = (steps: ReadonlyArray<WorkStep>) => {
  const all = steps.filter((step) => step.kind !== "reasoning");
  const succeeded = all.filter((step) => !failedDocumentStep(step));
  const acting = succeeded.length ? succeeded : all;
  const labels = [...new Set((acting.length ? acting : steps).flatMap(pastLabels))];
  if (labels.length === 0) return "Worked";
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

/** When the first call started, if the calls say. */
export const workStart = (steps: ReadonlyArray<WorkStep>) => {
  const starts = steps.flatMap(stepActivities).flatMap((call) => call.startedAt ?? []);
  return starts.length ? Math.min(...starts) : undefined;
};
