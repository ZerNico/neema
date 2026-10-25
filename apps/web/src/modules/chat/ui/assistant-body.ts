import type { AssistantFile } from "../assistant-output.ts";
import { isResearchStep } from "./research-steps.ts";
import type { Attachment } from "~/modules/attachments/schema.ts";
import type {
  CompactionActivity,
  DesktopToolActivity,
  DocumentToolActivity,
  ImageToolActivity,
  OfficeActivity,
  ToolActivity,
  ToolFileActivity,
  ToolLoadActivity,
  WebToolActivity,
  KnowledgeToolActivity,
  SkillToolActivity,
} from "../client/use-message-stream.ts";
import { isOfficeActivity } from "../client/use-message-stream.ts";
import { isBrowserTool } from "~/modules/browser/tool-schema.ts";
import { scanUiFences } from "~/modules/genui/fences.ts";

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
  | { kind: "tool"; activity: BodyToolActivity }
  | { kind: "compaction"; activity: CompactionActivity }
  | { kind: "steer"; activity: AssistantSteer };

/** Loading tools shows nothing, so the body never holds one. */
type BodyToolActivity = Exclude<ToolActivity, ToolLoadActivity>;

export type AssistantBodyPart =
  | { kind: "file"; key: string; file: AssistantFile }
  /** The answer's reasoning, drawn as the first step of the work it leads. */
  | { kind: "reasoning"; key: string }
  | WorkPart
  | {
      kind: "text";
      key: string;
      content: string;
      streaming: boolean;
      /** UTF-16 offset of `content` in the answer, which keys its ```ui blocks. */
      start: number;
    }
  | { kind: "web"; key: string; activities: WebToolActivity[] }
  | { kind: "skill"; key: string; activities: SkillToolActivity[] }
  | { kind: "knowledge"; key: string; activities: KnowledgeToolActivity[] }
  /** A run of browser calls, one row like the web's: the steps and pages behind it. */
  | { kind: "browser"; key: string; activities: DesktopToolActivity[] }
  | WorkingFilePart
  | DocumentPart
  /** One image call with the images it made, drawn where the call was made. */
  | { kind: "image"; key: string; activity: ImageToolActivity; files: AssistantFile[] }
  | {
      kind: "tool";
      key: string;
      activity: Exclude<
        BodyToolActivity,
        WebToolActivity | OfficeActivity | ToolFileActivity | ImageToolActivity
      >;
    }
  | { kind: "compaction"; key: string; activity: CompactionActivity }
  | { kind: "steer"; key: string; steer: AssistantSteer };

/**
 * One document's run of reads and edits, one step of the work rather than a
 * row per call. A document the answer created is a card of its own instead.
 */
export interface DocumentPart {
  kind: "document";
  key: string;
  documentId?: string;
  activities: DocumentToolActivity[];
  /** The answer touched more than one document, so rows say which. */
  named?: boolean;
}

/** Whether a document call makes one. */
export const createsDocument = (name: string) => name === "create_document";

/** A call that made a document: drawn as its card, which is what the person receives. */
export const isDocumentCard = (activity: DocumentToolActivity) =>
  createsDocument(activity.name) &&
  // A creation someone typed into as it streamed still made the document.
  (activity.result?.outcome === "created" || activity.result?.outcome === "conflict");

const creating = (call: DocumentToolActivity) => createsDocument(call.name);

/**
 * One working file's run of calls: deck or workbook steps and the publish that
 * delivered it, so a draft reads as one step of the work rather than a row per
 * call. The delivered file is named here and drawn as its own part after the work.
 */
export interface WorkingFilePart {
  kind: "working-file";
  key: string;
  workingFileId?: string;
  steps: Array<OfficeActivity | ToolFileActivity>;
  /** Every file its publishes delivered, in order: a draft may be published more than once. */
  files: AssistantFile[];
  /** Nothing follows it in the answer yet. */
  newest?: boolean;
  /** No later part continues the same file. */
  final?: boolean;
}

/**
 * One run of the answer's own work (reasoning, searches, reads, commands)
 * between pieces of text, folded under one line the way ChatGPT and Claude do.
 * What the person acts on or receives stays outside it.
 */
export interface WorkPart {
  kind: "work";
  key: string;
  steps: WorkStep[];
}

export type WorkStep = Exclude<AssistantBodyPart, WorkPart>;

const WORK_FAMILIES = new Set<ToolActivity["family"]>([
  "desktop",
  "custom",
  "integration",
  "project-file",
  "attachment",
  "history",
  "map",
]);

const isWorkStep = (part: WorkStep) =>
  part.kind === "reasoning" ||
  part.kind === "web" ||
  part.kind === "skill" ||
  part.kind === "knowledge" ||
  part.kind === "browser" ||
  part.kind === "working-file" ||
  part.kind === "document" ||
  part.kind === "compaction" ||
  (part.kind === "tool" && WORK_FAMILIES.has(part.activity.family));

/** A file or a created document: what the person receives from the work. */
const isDeliverable = (part: AssistantBodyPart) =>
  part.kind === "file" || (part.kind === "tool" && part.activity.family === "document");

/**
 * Adjacent work steps become one work part; everything else passes through. A
 * file or document delivered in the middle of a run waits until the run ends,
 * so it sits right after the work that made it instead of splitting it.
 */
const groupWork = (parts: ReadonlyArray<AssistantBodyPart>): AssistantBodyPart[] => {
  const grouped: AssistantBodyPart[] = [];
  let held: AssistantBodyPart[] = [];
  const release = () => {
    grouped.push(...held);
    held = [];
  };
  for (const part of parts) {
    const last = grouped.at(-1);
    if (part.kind !== "work" && isWorkStep(part)) {
      if (last?.kind === "work") last.steps.push(part);
      else grouped.push({ kind: "work", key: `work-${part.key}`, steps: [part] });
    } else if (isDeliverable(part) && last?.kind === "work") held.push(part);
    else {
      release();
      grouped.push(part);
    }
  }
  release();
  return grouped;
};

/** Rows name their document only when the answer touched more than one. */
const nameDocuments = (parts: AssistantBodyPart[], tools: ReadonlyArray<ToolActivity>) => {
  const documents = new Set(
    tools.flatMap((call) =>
      call.family === "document" && call.result?.documentId ? [call.result.documentId] : [],
    ),
  );
  if (documents.size > 1) for (const part of parts) if (part.kind === "document") part.named = true;
  return parts;
};

/** Marks where each draft sits, then gives every delivered file a part of its own. */
const placeWorkingFiles = (parts: ReadonlyArray<AssistantBodyPart>): AssistantBodyPart[] => {
  const lastOfFile = new Map<string, number>();
  parts.forEach((part, index) => {
    if (part.kind === "working-file" && part.workingFileId)
      lastOfFile.set(part.workingFileId, index);
  });
  return parts.flatMap((part, index): AssistantBodyPart[] => {
    if (part.kind !== "working-file") return [part];
    part.newest = index === parts.length - 1;
    part.final = !part.workingFileId || lastOfFile.get(part.workingFileId) === index;
    const file: AssistantBodyPart[] = part.files.map((delivered) => ({
      kind: "file",
      key: `file-${delivered.attachment.id}`,
      file: delivered,
    }));
    // Another tool's file, published: the card says it all, and an empty step
    // would only sit in the work line. Still publishing or failed, it is a step.
    const publishedOnly =
      part.steps.every((step) => step.family === "tool-file") &&
      part.steps.every((step) => step.status === "complete");
    return publishedOnly ? file : [part, ...file];
  });
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
  reasoning = false,
}: {
  content: string;
  rawTextLength?: number;
  streaming: boolean;
  tools: ToolActivity[];
  compactions: CompactionActivity[];
  files?: ReadonlyArray<AssistantFile>;
  steers?: ReadonlyArray<AssistantSteer>;
  /** Whether the answer reasoned; its one block leads the first run of work. */
  reasoning?: boolean;
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
  // An image call's files are drawn inside its part, in place of its placeholder.
  const imageCalls = new Set(
    tools.flatMap((activity) => (activity.family === "image" ? [activity.callId] : [])),
  );
  const imageFiles = new Map<string, AssistantFile[]>();
  const activities: PositionedActivity[] = [
    ...files
      .filter((activity) => {
        const call = activity.origin?.toolCallId;
        if (call && imageCalls.has(call)) {
          imageFiles.set(call, [...(imageFiles.get(call) ?? []), activity]);
          return false;
        }
        const publish = published.get(activity.attachment.id);
        if (publish) claimed.set(publish, activity);
        return !publish;
      })
      .map((activity): PositionedActivity => ({ kind: "file", activity })),
    ...tools
      // Loading tools shows nothing; left in, it would split a run of calls
      // that otherwise group into one row.
      .filter((activity): activity is BodyToolActivity => activity.family !== "tool-load")
      .filter((activity) => !(isResearchStep(activity) && researchRuns.has(activity.runId)))
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

  const parts: AssistantBodyPart[] = reasoning ? [{ kind: "reasoning", key: "reasoning" }] : [];
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
    } else if (item.activity.family === "image") {
      parts.push({
        kind: "image",
        key: `image-${item.activity.callId}`,
        activity: item.activity,
        files: imageFiles.get(item.activity.callId) ?? [],
      });
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
    } else if (item.activity.family === "document" && !isDocumentCard(item.activity)) {
      const call = item.activity;
      const last = parts.at(-1);
      const id = call.result?.documentId;
      // Like a draft's steps: a call joins the run before it unless it names
      // another document, and a creation, running or failed, joins nothing.
      if (
        last?.kind === "document" &&
        !creating(call) &&
        !creating(last.activities[0]!) &&
        (!id || !last.documentId || id === last.documentId)
      ) {
        last.activities.push(call);
        if (!last.documentId && id) last.documentId = id;
      } else
        parts.push({
          kind: "document",
          key: `document-${call.callId}`,
          ...(id ? { documentId: id } : {}),
          activities: [call],
        });
    } else if (isOfficeActivity(item.activity) || item.activity.family === "tool-file") {
      const step = item.activity;
      const last = parts.at(-1);
      // A step joins the draft before it unless it names a different file; a
      // running call has no file ID yet and must not flash into its own row.
      // A created file is a one-off of its own: it joins nothing, and nothing joins it.
      const oneOff = (candidate: WorkingFilePart["steps"][number]) =>
        candidate.family === "tool-file" && candidate.name === "create_file";
      let group: WorkingFilePart;
      if (
        last?.kind === "working-file" &&
        !oneOff(step) &&
        !oneOff(last.steps[0]!) &&
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
          files: [],
        };
        parts.push(group);
      }
      const file = claimed.get(step.callId);
      if (file) group.files.push(file);
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
        start,
      });
  };
  if (!chronological) {
    for (const item of activities) appendActivity(item);
    appendText(0, content.length, streaming);
    return { chronological, parts: groupWork(placeWorkingFiles(nameDocuments(parts, tools))) };
  }

  // A ```ui block is one widget: an activity anchored inside it shows after
  // it, so the fence never splits across two markdown renders. Display only;
  // the stored offsets are untouched.
  const fences = scanUiFences(content);
  const outsideFence = (offset: number) =>
    fences.find((fence) => offset > fence.start && offset < fence.end)?.end ?? offset;
  let cursor = 0;
  for (const item of activities) {
    const offset = outsideFence(item.activity.textOffset!);
    // A durable start can be ahead of the raw snapshot too. While streaming,
    // wait rather than reveal it early or fabricate a temporary legacy order.
    if (offset > content.length) break;
    appendText(cursor, offset, false);
    appendActivity(item);
    cursor = offset;
  }
  appendText(cursor, content.length, streaming);
  return { chronological, parts: groupWork(placeWorkingFiles(nameDocuments(parts, tools))) };
}
