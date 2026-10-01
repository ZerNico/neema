import type { AssistantFile } from "../assistant-output.ts";
import type { Attachment } from "~/modules/attachments/schema.ts";
import type {
  CompactionActivity,
  DesktopToolActivity,
  OfficeActivity,
  ToolActivity,
  ToolFileActivity,
  WebToolActivity,
  KnowledgeToolActivity,
  SkillToolActivity,
} from "../client/use-message-stream.ts";
import { isOfficeActivity } from "../client/use-message-stream.ts";
import { isBrowserTool } from "~/modules/browser/tool-schema.ts";

/**
 * A message the person steered into this answer while it ran. It belongs to
 * the answer, so it is drawn inside it where it arrived rather than as a
 * transcript row of its own.
 */
export interface AssistantSteer {
  id: string;
  content: string;
  /** Raw content offset where it arrived. */
  textOffset: number;
  /** The model round it followed; it sorts after that round's activity. */
  turnIndex: number;
  attachments: ReadonlyArray<Attachment>;
  /** The queue entry it came from; set only while it arrives live. */
  queueEntryId?: string;
}

type PositionedActivity =
  | { kind: "file"; activity: AssistantFile }
  | { kind: "tool"; activity: ToolActivity }
  | { kind: "compaction"; activity: CompactionActivity }
  | { kind: "steer"; activity: AssistantSteer };

export type AssistantBodyPart =
  | { kind: "file"; key: string; file: AssistantFile }
  | { kind: "text"; key: string; content: string; streaming: boolean }
  | { kind: "web"; key: string; activities: WebToolActivity[] }
  | { kind: "skill"; key: string; activities: SkillToolActivity[] }
  | { kind: "knowledge"; key: string; activities: KnowledgeToolActivity[] }
  /** A run of browser calls, one row like the web's: the steps and pages behind it. */
  | { kind: "browser"; key: string; activities: DesktopToolActivity[] }
  | WorkingFilePart
  | {
      kind: "tool";
      key: string;
      activity: Exclude<ToolActivity, WebToolActivity | OfficeActivity | ToolFileActivity>;
    }
  | { kind: "compaction"; key: string; activity: CompactionActivity }
  | { kind: "steer"; key: string; steer: AssistantSteer };

/**
 * One working file's run of calls: deck or workbook steps, the publish that
 * delivered it, and the delivered file itself, so a draft reads as one activity
 * rather than a row per call plus a separate file card.
 */
export interface WorkingFilePart {
  kind: "working-file";
  key: string;
  workingFileId?: string;
  steps: Array<OfficeActivity | ToolFileActivity>;
  file?: AssistantFile;
}

/** A draft still being worked on is its own live signal; nothing else needs to say "Thinking". */
export const liveWorkingFile = (parts: ReadonlyArray<AssistantBodyPart>) => {
  const last = parts.at(-1);
  return (
    last?.kind === "working-file" &&
    !last.steps.some((step) => step.family === "tool-file" && step.status === "complete")
  );
};

const turnOf = (item: PositionedActivity) =>
  item.kind !== "compaction" ? (item.activity.turnIndex ?? 0) : item.activity.beforeTurnIndex;
const orderOf = (item: PositionedActivity) =>
  item.kind === "compaction"
    ? item.activity.passIndex
    : // Claimed only once its round's results are terminal: after all of them.
      item.kind === "steer"
      ? Number.MAX_SAFE_INTEGER
      : (item.activity.callIndex ?? 0);

/** Original UTF-16 offsets, never rendered markdown lengths or clamped anchors. */
export function projectAssistantBody({
  content,
  rawTextLength = content.length,
  streaming,
  tools,
  compactions,
  files = [],
  steers = [],
}: {
  content: string;
  rawTextLength?: number;
  streaming: boolean;
  tools: ToolActivity[];
  compactions: CompactionActivity[];
  files?: ReadonlyArray<AssistantFile>;
  steers?: ReadonlyArray<AssistantSteer>;
}): { chronological: boolean; parts: AssistantBodyPart[] } {
  const researchRuns = new Set(
    tools.flatMap((activity) =>
      activity.family === "research" && activity.progress ? [activity.progress.runId] : [],
    ),
  );
  const published = new Map(
    tools.flatMap((activity) =>
      activity.family === "tool-file" && activity.attachmentId
        ? [[activity.attachmentId, activity.callId] as const]
        : [],
    ),
  );
  const claimed = new Map<string, AssistantFile>();
  const activities: PositionedActivity[] = [
    ...files
      .filter((activity) => {
        const publish = published.get(activity.attachment.id);
        if (publish) claimed.set(publish, activity);
        return !publish;
      })
      .map((activity): PositionedActivity => ({ kind: "file", activity })),
    ...tools
      .filter(
        (activity) =>
          !(
            (activity.family === "web" ||
              activity.family === "knowledge" ||
              activity.family === "skill") &&
            activity.runId &&
            researchRuns.has(activity.runId)
          ),
      )
      .map((activity): PositionedActivity => ({ kind: "tool", activity })),
    ...compactions
      .filter((activity) => !(activity.runId && researchRuns.has(activity.runId)))
      .map((activity): PositionedActivity => ({ kind: "compaction", activity })),
    ...steers.map((activity): PositionedActivity => ({ kind: "steer", activity })),
  ];
  // Logical ordering is authoritative for equal offsets and legacy messages.
  // oxlint-disable-next-line no-array-sort -- fresh array
  activities.sort(
    (a, b) =>
      turnOf(a) - turnOf(b) ||
      (a.kind === "compaction" || b.kind === "compaction"
        ? a.kind === b.kind
          ? orderOf(a) - orderOf(b)
          : a.kind === "compaction"
            ? -1
            : 1
        : orderOf(a) - orderOf(b) || (a.kind === b.kind ? 0 : a.kind === "file" ? -1 : 1)),
  );
  let previous = 0;
  const chronological = activities.every(({ activity }) => {
    const offset = activity.textOffset;
    if (
      offset === undefined ||
      !Number.isSafeInteger(offset) ||
      offset < previous ||
      (!streaming && offset > rawTextLength)
    )
      return false;
    previous = offset;
    return true;
  });

  const parts: AssistantBodyPart[] = [];
  const appendActivity = (item: PositionedActivity) => {
    if (item.kind === "file") {
      parts.push({
        kind: "file",
        key: `file-${item.activity.attachment.id}`,
        file: item.activity,
      });
    } else if (item.kind === "steer") {
      parts.push({ kind: "steer", key: `steer-${item.activity.id}`, steer: item.activity });
    } else if (item.kind === "compaction") {
      parts.push({ ...item, key: `compaction-${item.activity.eventId}` });
    } else if (item.activity.family === "web") {
      const last = parts.at(-1);
      if (last?.kind === "web") last.activities.push(item.activity);
      else
        parts.push({
          kind: "web",
          key: `web-${item.activity.callId}`,
          activities: [item.activity],
        });
    } else if (item.activity.family === "desktop" && isBrowserTool(item.activity.name)) {
      const last = parts.at(-1);
      if (last?.kind === "browser") last.activities.push(item.activity);
      else
        parts.push({
          kind: "browser",
          key: `browser-${item.activity.callId}`,
          activities: [item.activity],
        });
    } else if (item.activity.family === "skill") {
      const last = parts.at(-1);
      if (last?.kind === "skill") last.activities.push(item.activity);
      else
        parts.push({
          kind: "skill",
          key: `skill-${item.activity.callId}`,
          activities: [item.activity],
        });
    } else if (item.activity.family === "knowledge" && item.activity.name !== "knowledge_context") {
      // Same shape as web: one collapsed row per run of knowledge calls, with
      // the individual searches and reads in its disclosure.
      const last = parts.at(-1);
      if (last?.kind === "knowledge") last.activities.push(item.activity);
      else
        parts.push({
          kind: "knowledge",
          key: `knowledge-${item.activity.callId}`,
          activities: [item.activity],
        });
    } else if (isOfficeActivity(item.activity) || item.activity.family === "tool-file") {
      const step = item.activity;
      const last = parts.at(-1);
      // A step joins the draft before it unless it names a different file; a
      // running call has no file ID yet and must not flash into its own row.
      let group: WorkingFilePart;
      if (
        last?.kind === "working-file" &&
        (!step.workingFileId || !last.workingFileId || step.workingFileId === last.workingFileId)
      ) {
        group = last;
        group.steps.push(step);
        if (!group.workingFileId && step.workingFileId) group.workingFileId = step.workingFileId;
      } else {
        group = {
          kind: "working-file",
          key: `working-file-${step.callId}`,
          ...(step.workingFileId ? { workingFileId: step.workingFileId } : {}),
          steps: [step],
        };
        parts.push(group);
      }
      const file = claimed.get(step.callId);
      if (file) group.file = file;
    } else {
      parts.push({ kind: "tool", key: `tool-${item.activity.callId}`, activity: item.activity });
    }
  };
  const appendText = (start: number, end: number, active: boolean) => {
    if (end > start)
      parts.push({
        kind: "text",
        key: `text-${start}`,
        content: content.slice(start, end),
        streaming: active,
      });
  };
  if (!chronological) {
    for (const item of activities) appendActivity(item);
    appendText(0, content.length, streaming);
    return { chronological, parts };
  }

  let cursor = 0;
  for (const item of activities) {
    const offset = item.activity.textOffset!;
    // A durable start can be ahead of the raw snapshot too. While streaming,
    // wait rather than reveal it early or fabricate a temporary legacy order.
    if (offset > content.length) break;
    appendText(cursor, offset, false);
    appendActivity(item);
    cursor = offset;
  }
  appendText(cursor, content.length, streaming);
  return { chronological, parts };
}
