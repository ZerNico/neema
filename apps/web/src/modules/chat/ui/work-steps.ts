import { m } from "~/paraglide/messages.js";
import { isBrowserTool } from "~/modules/browser/tool-schema.ts";
import type { ToolActivity } from "../client/use-message-stream.ts";
import type { WorkStep } from "./assistant-body.ts";
import {
  type Clause,
  clause,
  documentRunClause,
  documentRunLabel,
  documentRunSucceeded,
} from "./document-activity-label.ts";

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

type OfficeNoun = "presentation" | "spreadsheet" | "document";
const OFFICE_NOUN = {
  presentation: "presentation",
  spreadsheet: "spreadsheet",
  word: "document",
} as const satisfies Record<string, OfficeNoun>;

/** Each Office noun's own sentences, since its gender changes the German around it. */
const OFFICE_WORDS: Record<
  OfficeNoun,
  { working: () => string; created: () => string; edited: () => string; read: () => string }
> = {
  presentation: {
    working: m.chat_work_presentation_working,
    created: m.chat_work_presentation_created,
    edited: m.chat_work_presentation_edited,
    read: m.chat_work_presentation_read,
  },
  spreadsheet: {
    working: m.chat_work_spreadsheet_working,
    created: m.chat_work_spreadsheet_created,
    edited: m.chat_work_spreadsheet_edited,
    read: m.chat_work_spreadsheet_read,
  },
  document: {
    working: m.chat_work_document_working,
    created: m.chat_work_document_created,
    edited: m.chat_work_document_edited,
    read: m.chat_work_document_read,
  },
};

/** The Office family a draft step edits; a publish-only step has none. */
const officeNoun = (step: Extract<WorkStep, { kind: "working-file" }>) => {
  const office = step.steps.find((call) => call.family !== "tool-file");
  return office ? OFFICE_NOUN[office.family] : null;
};

/** What a step is doing, in the present tense, for the live header. */
export function stepLabel(step: WorkStep): string {
  switch (step.kind) {
    case "reasoning":
      return m.chat_thinking();
    case "web":
      return step.activities.some(
        (call) => call.name === "read_url" && call.status === "running",
      ) || step.activities.every((call) => call.name === "read_url")
        ? m.chat_work_reading_pages()
        : m.chat_work_searching_web();
    case "knowledge":
      return m.chat_work_searching_documents();
    case "skill":
      return m.chat_work_reading_skill();
    case "browser":
      return m.chat_work_using_browser();
    case "compaction":
      return m.chat_work_summarizing();
    case "document":
      return documentRunLabel(step.activities, step.named ?? false);
    case "working-file": {
      const noun = officeNoun(step);
      return noun ? OFFICE_WORDS[noun].working() : m.chat_work_publishing_file();
    }
    case "tool": {
      const call = step.activity;
      switch (call.family) {
        case "integration":
          return m.chat_work_using({ name: call.label });
        case "custom":
          return m.chat_work_running({ name: call.displayName });
        case "project-file":
          return m.chat_work_project_files();
        case "attachment":
          return m.chat_work_reading_file();
        case "history":
          return call.name === "search_chats"
            ? m.chat_work_searching_chats()
            : call.name === "read_chat"
              ? m.chat_work_reading_chat()
              : m.chat_work_looking_back();
        case "map":
          return m.chat_work_route();
        case "desktop":
          if (isBrowserTool(call.name)) return m.chat_work_using_browser();
          if (call.name === "run_command") return m.chat_work_running_command();
          if (
            call.name === "write_local_file" ||
            call.name === "edit_local_file" ||
            call.name === "move_local_file" ||
            call.name === "delete_local_file"
          )
            return m.chat_work_editing_files();
          if (call.name.startsWith("request_")) return m.chat_work_asking_access();
          return m.chat_work_looking_through_files();
        default:
          return m.chat_work_working();
      }
    }
    default:
      return m.chat_work_working();
  }
}

/** What a settled step did, in the past tense, as it reads inside a summary. */
const pastClauses = (step: WorkStep): Clause[] => {
  switch (step.kind) {
    case "reasoning":
      return [clause(m.chat_work_past_thought())];
    case "web": {
      const searched = step.activities.some((call) => call.name !== "read_url");
      const pages = new Set(
        step.activities.flatMap((call) => (call.name === "read_url" ? call.targets : [])),
      ).size;
      const read = pages === 0 ? [] : [clause(m.chat_work_past_read_pages({ count: pages }))];
      return searched ? [clause(m.chat_work_past_searched_web()), ...read] : read;
    }
    case "knowledge":
      return [clause(m.chat_work_past_searched_documents())];
    case "skill":
      return [clause(m.chat_work_past_read_skill())];
    case "browser":
      return [clause(m.chat_work_past_used_browser())];
    case "compaction":
      return [clause(m.chat_work_past_summarized())];
    case "document":
      return [documentRunClause(step.activities, step.named ?? false)];
    case "working-file": {
      const noun = officeNoun(step);
      if (!noun) return [clause(m.chat_work_past_published_file())];
      const done = step.steps.filter((call) => call.status === "complete");
      if (done.some((call) => call.family !== "tool-file" && call.origin === "created"))
        return [clause(OFFICE_WORDS[noun].created())];
      if (done.some((call) => call.name.startsWith("edit_")))
        return [clause(OFFICE_WORDS[noun].edited())];
      return [clause(OFFICE_WORDS[noun].read())];
    }
    case "tool": {
      const call = step.activity;
      switch (call.family) {
        // A shipped integration's label already says what the call did: "Searched Outline".
        case "integration":
          return [{ inline: lowerFirst(call.label), lead: call.label }];
        case "custom":
          return [clause(m.chat_work_past_ran({ name: call.displayName }), call.displayName)];
        case "project-file":
          return [clause(m.chat_work_past_project_files())];
        case "attachment":
          return [clause(m.chat_work_past_read_file())];
        case "history":
          return [
            clause(
              call.name === "search_chats"
                ? m.chat_work_past_searched_chats()
                : call.name === "read_chat"
                  ? m.chat_work_past_read_chat()
                  : m.chat_work_past_looked_back(),
            ),
          ];
        case "map":
          return [clause(m.chat_work_past_route())];
        case "desktop":
          if (isBrowserTool(call.name)) return [clause(m.chat_work_past_used_browser())];
          if (call.name === "run_command") return [clause(m.chat_work_past_ran_command())];
          if (
            call.name === "write_local_file" ||
            call.name === "edit_local_file" ||
            call.name === "move_local_file" ||
            call.name === "delete_local_file"
          )
            return [clause(m.chat_work_past_edited_files())];
          if (call.name.startsWith("request_")) return [clause(m.chat_work_past_asked_access())];
          return [clause(m.chat_work_past_looked_through_files())];
        default:
          return [clause(m.chat_work_past_worked())];
      }
    }
    default:
      return [clause(m.chat_work_past_worked())];
  }
};

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** A document step none of whose calls succeeded; its own row says so. */
const failedDocumentStep = (step: WorkStep) =>
  step.kind === "document" &&
  step.activities.every((call) => call.status !== "running") &&
  !documentRunSucceeded(step.activities);

/** How a summary names an integration: a server's own tools have no labels written for people. */
export type IntegrationNamer = (integrationId: string) => { name: string; listed: boolean } | null;

/** "A, B and C" in the reader's language, keeping English without a serial comma. */
const joined = (items: ReadonlyArray<string>) =>
  items.length > 1
    ? m.chat_work_list({ head: items.slice(0, -1).join(", "), last: items.at(-1)! })
    : (items[0] ?? "");

/**
 * A server's tools by the service and what they did: "Looked in Trello and
 * Notion", "Updated Linear". Its tools' own names stay in the steps below.
 */
const serviceClauses = (calls: ReadonlyArray<ToolActivity>, describe: IntegrationNamer) => {
  const services = new Map<string, boolean>();
  for (const call of calls) {
    if (call.family !== "integration") continue;
    const name = describe(call.integrationId)?.name ?? call.label;
    const changed =
      call.access !== "read" && call.status === "complete" && !call.refused && !call.error;
    services.set(name, (services.get(name) ?? false) || changed);
  }
  const looked = [...services].flatMap(([name, changed]) => (changed ? [] : [name]));
  const updated = [...services].flatMap(([name, changed]) => (changed ? [name] : []));
  return [
    ...(looked.length
      ? [clause(m.chat_work_past_looked_in({ services: joined(looked) }), ...looked)]
      : []),
    ...(updated.length
      ? [clause(m.chat_work_past_updated({ services: joined(updated) }), ...updated)]
      : []),
  ];
};

/**
 * "Searched the web, read 2 pages and ran a command": each kind of step once,
 * in order. Thinking is named only when it is all there was, and a failed
 * document step only when nothing else was done: a retry is not news.
 */
export const workSummary = (steps: ReadonlyArray<WorkStep>, describe?: IntegrationNamer) => {
  const all = steps.filter((step) => step.kind !== "reasoning");
  const succeeded = all.filter((step) => !failedDocumentStep(step));
  const acting = succeeded.length ? succeeded : all;
  const listedCall = (step: WorkStep) =>
    step.kind === "tool" &&
    step.activity.family === "integration" &&
    Boolean(describe?.(step.activity.integrationId)?.listed);
  const chosen = acting.length ? acting : steps;
  const services = describe
    ? serviceClauses(
        chosen.flatMap((step) => (step.kind === "tool" && listedCall(step) ? [step.activity] : [])),
        describe,
      )
    : [];
  // Where the first of a server's calls came, so the summary keeps the order things happened in.
  const first = chosen.findIndex(listedCall);
  const clauses = [
    ...new Map(
      chosen
        .flatMap((step, index) =>
          listedCall(step) ? (index === first ? services : []) : pastClauses(step),
        )
        .map((item) => [item.inline, item] as const),
    ).values(),
  ];
  if (clauses.length === 0) return clause(m.chat_work_past_worked()).lead;
  const shown = clauses.slice(0, 3).map((item, index) => (index === 0 ? item.lead : item.inline));
  if (clauses.length > 3) return m.chat_work_list_more({ list: shown.join(", ") });
  return joined(shown);
};

export const formatDuration = (ms: number) => {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return m.chat_duration_seconds({ seconds });
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest
    ? m.chat_duration_minutes_seconds({ minutes, seconds: rest })
    : m.chat_duration_minutes({ minutes });
};

/** When the first call started, if the calls say. */
export const workStart = (steps: ReadonlyArray<WorkStep>) => {
  const starts = steps.flatMap(stepActivities).flatMap((call) => call.startedAt ?? []);
  return starts.length ? Math.min(...starts) : undefined;
};
