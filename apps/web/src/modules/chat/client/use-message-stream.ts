import {
  AgentDraftToolEnvelope,
  projectAgentDraftResult,
  agentDraftResultOk,
  type AgentDraftActivityResult,
} from "~/modules/agents/tool-schema.ts";
import {
  isOfficeFamily,
  OFFICE_FAMILIES,
  officeFamilyOfEdit,
  type OfficeFamily,
} from "~/modules/office/families.ts";
import {
  DocumentToolEnvelope,
  documentResultOk,
  projectDocumentResult,
  type DocumentActivityResult,
} from "~/modules/documents/tool-schema.ts";
import {
  ProjectFileToolEnvelope,
  projectFileResultOk,
  projectProjectFileResult,
  type ProjectFileActivityResult,
} from "~/modules/projects/file-tool-schema.ts";
import { SkillToolEnvelope } from "~/modules/skills/tool-schema.ts";
import {
  ScheduleDraftToolEnvelope,
  projectScheduleDraftResult,
  scheduleDraftResultOk,
  type ScheduleDraftActivityResult,
} from "~/modules/schedules/tool-schema.ts";
import { CustomToolEnvelope } from "~/modules/custom-tools/tool-schema.ts";
import { IntegrationToolEnvelope } from "~/modules/integrations/tool-schema.ts";
import type { IntegrationSource } from "~/modules/tools/source-schema.ts";
import {
  AssistantFile,
  ASSISTANT_FILE_LIMITS,
  mergeLookups,
  NO_LOOKUPS,
  type UiLookups,
} from "../assistant-output.ts";
import { SteerChunkEnvelope } from "../schema.ts";
import type { AssistantSteer } from "../ui/assistant-body.ts";
import {
  KnowledgeToolEnvelope,
  type KnowledgeActivitySummary,
} from "~/modules/knowledge/tool-schema.ts";
import { useQueryClient } from "@tanstack/react-query";
import { Option, Schema } from "effect";
import { ResearchProgress } from "../research-schema.ts";
import { DesktopToolName, DesktopToolResult } from "~/modules/desktop/tool-schema.ts";
import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { createLiveText, type LiveText } from "./live-text.ts";
import { MemoryActivityReason, type MemoryActivityOutcome } from "~/modules/tools/schema.ts";
import { ToolFileEnvelope } from "../tool-file-schema.ts";
import { readPresentedQuestions, type AskUserQuestion } from "~/modules/tools/ask-user-schema.ts";
import { PlanStep } from "~/modules/tools/plan-schema.ts";
import { LazyToolFamily } from "~/modules/tools/tool-load-schema.ts";
import { AttachmentReadActivity } from "../attachment-tool-schema.ts";
import { MapRouteSummary } from "~/modules/genui/map-tool-schema.ts";

export interface ToolPageStatus {
  url: string;
  title?: string;
  status: "pending" | "reading" | "done" | "error";
  error?: string;
}

export type { Source as ToolSource } from "~/modules/tools/source-schema.ts";
import type { Source as ToolSource } from "~/modules/tools/source-schema.ts";

export interface PlanToolActivity extends ToolActivityBase {
  family: "plan";
  /** The latest accepted list; absent until one lands or when the call failed. */
  steps?: ReadonlyArray<PlanStep>;
}

/** A scheduled run's answer told its owner; the text is what they were sent. */
export interface NotifyToolActivity extends ToolActivityBase {
  family: "notify";
  message?: string;
}

/** A route looked up with real distances; the row names its stops and totals. */
export interface MapToolActivity extends ToolActivityBase {
  family: "map";
  route?: MapRouteSummary;
}

export interface AttachmentToolActivity extends ToolActivityBase {
  family: "attachment";
  /** Which file and part; the text itself only ever reached the model. */
  read?: AttachmentReadActivity;
}

export interface ToolLoadActivity extends ToolActivityBase {
  family: "tool-load";
  loaded?: ReadonlyArray<LazyToolFamily>;
}

export interface KnowledgeToolActivity extends ToolActivityBase {
  family: "knowledge";
  summary?: KnowledgeActivitySummary;
  sources?: ToolSource[];
}

export interface SkillToolActivity extends ToolActivityBase {
  family: "skill";
  skillId: string;
  skillName: string;
  path: string;
}

interface ToolActivityBase {
  callId: string;
  name: string;
  runId?: string;
  taskId?: string;
  turnIndex?: number;
  callIndex?: number;
  /** UTF-16 offset in the original assistant content, captured at start. */
  textOffset?: number;
  status: "running" | "complete" | "error";
  error?: string;
  /** When the call started and settled (epoch ms): from its row on reload, the client clock live. */
  startedAt?: number;
  completedAt?: number;
}

/** Live/durable view of one web tool call, upserted by callId from tool chunks. */
export interface WebToolActivity extends ToolActivityBase {
  family: "web";
  targets: string[];
  resultCount?: number;
  pagesFetched?: number;
  pages?: ToolPageStatus[];
  sources?: ToolSource[];
}

/**
 * Memory activity is deliberately summary-only. User memory content and every
 * web-only field stay out of both stream state and the rendered activity row.
 */
export interface MemoryToolActivity extends ToolActivityBase {
  family: "memory";
  outcome?: MemoryActivityOutcome;
  /** Why a save was refused; only ever one of the handler's fixed reasons. */
  reason?: MemoryActivityReason;
  /** The chat's project kept it rather than the person's own memory. */
  scope?: "project";
}

export interface AskToolActivity extends ToolActivityBase {
  family: "ask";
  /** Only a validated, successful durable presentation can supply questions. */
  questions?: ReadonlyArray<AskUserQuestion>;
}

export interface ResearchToolActivity extends ToolActivityBase {
  family: "research";
  progress?: ResearchProgress;
  sources?: ToolSource[];
  /** Stands in while the model writes the brief; replaced when the run starts. */
  writing?: true;
}

export const readResearchProgress = (value: unknown): ResearchProgress | null =>
  Option.getOrNull(Schema.decodeUnknownOption(ResearchProgress)(value));

export interface AgentDraftToolActivity extends ToolActivityBase {
  family: "agent-draft";
  result?: AgentDraftActivityResult;
}

export interface ScheduleDraftToolActivity extends ToolActivityBase {
  family: "schedule-draft";
  result?: ScheduleDraftActivityResult;
}

export interface DocumentToolActivity extends ToolActivityBase {
  family: "document";
  result?: DocumentActivityResult;
}

export interface ProjectFileToolActivity extends ToolActivityBase {
  family: "project-file";
  result?: ProjectFileActivityResult;
}

export interface DesktopToolActivity extends ToolActivityBase {
  family: "desktop";
  /** Narrowed from the base so the transcript can switch on it exhaustively. */
  name: DesktopToolName;
  /** Present from `start`, because the page is what executes the call. */
  args?: Record<string, unknown>;
  result?: DesktopToolResult;
}

/** One publish of a working file; the attachment it delivered, once it has. */
export interface ToolFileActivity extends ToolActivityBase {
  family: "tool-file";
  attachmentId?: string;
  workingFileId?: string;
}

/** One call of an Office editor, carrying only the bounded summary the transcript shows. */
export type OfficeActivity = {
  [F in OfficeFamily]: ToolActivityBase &
    Partial<ReturnType<(typeof OFFICE_FAMILIES)[F]["summary"]>> & {
      family: F;
      /** Stands in for a call the model is still writing; replaced when it starts. */
      writing?: true;
    };
}[OfficeFamily];
export const isOfficeActivity = (activity: ToolActivity): activity is OfficeActivity =>
  isOfficeFamily(activity.family);

/** One admin-authored code tool call; the display name rides the envelope. */
export interface CustomToolActivity extends ToolActivityBase {
  family: "custom";
  displayName: string;
  resultPreview?: string;
  resultChars?: number;
  /** Attachments the call produced; the bytes live in the message's files. */
  fileIds?: ReadonlyArray<string>;
  workingFiles?: ReadonlyArray<{ id: string; revision: number; name: string }>;
}

/** One call into a connected service; a declined or unpermitted call is `refused`. */
export interface IntegrationToolActivity extends ToolActivityBase {
  family: "integration";
  integrationId: string;
  tool: string;
  label: string;
  access: "read" | "write" | "destructive";
  summary: string | null;
  refused?: boolean;
  link?: { title: string; url: string };
  sources?: ReadonlyArray<IntegrationSource>;
}

export type ToolActivity =
  | AgentDraftToolActivity
  | IntegrationToolActivity
  | ScheduleDraftToolActivity
  | CustomToolActivity
  | ToolFileActivity
  | OfficeActivity
  | DocumentToolActivity
  | ProjectFileToolActivity
  | DesktopToolActivity
  | WebToolActivity
  | MemoryToolActivity
  | AskToolActivity
  | PlanToolActivity
  | NotifyToolActivity
  | MapToolActivity
  | ToolLoadActivity
  | AttachmentToolActivity
  | ResearchToolActivity
  | KnowledgeToolActivity
  | SkillToolActivity;

export const isWebToolActivity = (activity: ToolActivity): activity is WebToolActivity =>
  activity.family === "web";

export const isMemoryToolActivity = (activity: ToolActivity): activity is MemoryToolActivity =>
  activity.family === "memory";

/**
 * One durable/live compaction occurrence. Position is relative to model/tool
 * turns inside this assistant response, not to the historical checkpoint it
 * may have produced.
 */
export interface CompactionActivity {
  eventId: string;
  runId?: string;
  taskId?: string;
  textOffset?: number;
  beforeTurnIndex: number;
  passIndex: number;
  scope: "history" | "active_rounds";
  status: "running" | "complete" | "failed";
  outcome?: "summary" | "hard_truncation";
  summary?: string;
}

/**
 * Everything but the answer and reasoning text, which stream through a
 * `LiveText` instead so their pacing does not re-render the whole chat.
 */
export interface StreamState {
  files: AssistantFile[];
  tools: ToolActivity[];
  /** Usually empty; one response may compact at several turn boundaries. */
  compactions: CompactionActivity[];
  /** Queued messages this answer took in, in the order it took them. */
  steers: AssistantSteer[];
  status: "idle" | "streaming" | "complete" | "error" | "aborted";
  /** Scanned pages being read before the answer starts; live only, never replayed. */
  reading: { read: number; total: number } | null;
  /** What the answer's ```ui blocks looked up: images, places, routes. */
  lookups: UiLookups;
}

type Action =
  | {
      kind: "reset";
      files?: AssistantFile[];
      tools: ToolActivity[];
      compactions: CompactionActivity[];
      steers?: AssistantSteer[];
      lookups?: UiLookups;
    }
  | {
      kind: "chunk";
      chunkKind: Exclude<ChunkKind, "text" | "reasoning">;
      delta: string;
      /** The server's time for the chunk, so a replayed call keeps its start. */
      at?: number;
    }
  | { kind: "reading"; reading: StreamState["reading"] }
  | { kind: "lookups"; lookups: UiLookups }
  | { kind: "done"; status: "complete" | "error" | "aborted" };

const MEMORY_OUTCOMES = new Set<MemoryActivityOutcome>([
  "created",
  "updated",
  "unchanged",
  "rejected",
]);

export const toMemoryActivityReason = (value: unknown): MemoryActivityReason | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(MemoryActivityReason)(value));

export const toMemoryActivityOutcome = (value: unknown): MemoryActivityOutcome | undefined => {
  if (typeof value !== "string") return undefined;
  if (MEMORY_OUTCOMES.has(value as MemoryActivityOutcome)) return value as MemoryActivityOutcome;
  if (value === "duplicate") return "unchanged";
  if (
    value === "limit_reached" ||
    value === "not_found" ||
    value === "protected" ||
    value === "disabled" ||
    value === "source_changed"
  ) {
    return "rejected";
  }
  return undefined;
};

export const readTextOffset = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * Parses a tool chunk envelope defensively: malformed rows must not crash the
 * stream; the chunk still advances lastSeq so resume cursors stay correct.
 */
export function applyToolChunk(
  tools: ToolActivity[],
  delta: string,
  onlyFamily?: ToolActivity["family"],
): ToolActivity[] {
  let envelope: unknown;
  try {
    envelope = JSON.parse(delta);
  } catch {
    return tools;
  }
  if (typeof envelope !== "object" || envelope === null) return tools;
  const e = envelope as {
    result?: unknown;
    progress?: unknown;
    runId?: string;
    taskId?: string;
    v?: number;
    family?: string;
    phase?: string;
    callId?: string;
    name?: string;
    turnIndex?: number;
    callIndex?: number;
    textOffset?: unknown;
    args?: { targets?: string[] };
    ok?: boolean;
    route?: unknown;
    outcome?: unknown;
    reason?: unknown;
    scope?: unknown;
    summary?: {
      targets?: string[];
      resultCount?: number;
      pagesFetched?: number;
      outcome?: unknown;
    };
    pages?: ToolPageStatus[];
    sources?: ToolSource[];
    error?: string;
  };
  if (e.v !== 1 || !e.callId || !e.name) return tools;
  if (
    e.family !== "agent-draft" &&
    e.family !== "schedule-draft" &&
    e.family !== "custom" &&
    e.family !== "tool-file" &&
    !isOfficeFamily(e.family) &&
    e.family !== "integration" &&
    e.family !== "document" &&
    e.family !== "project-file" &&
    e.family !== "web" &&
    e.family !== "memory" &&
    e.family !== "ask" &&
    e.family !== "plan" &&
    e.family !== "notify" &&
    e.family !== "map" &&
    e.family !== "tool-load" &&
    e.family !== "attachment" &&
    e.family !== "research" &&
    e.family !== "knowledge" &&
    e.family !== "skill" &&
    e.family !== "desktop"
  )
    return tools;

  const family = e.family;
  if (onlyFamily !== undefined && family !== onlyFamily) return tools;
  const index = tools.findIndex((activity) => activity.callId === e.callId);
  const existing = index === -1 ? undefined : tools[index];
  if (existing && existing.family !== family) return tools;
  const textOffset =
    existing?.textOffset ??
    (e.phase === "start" && !existing ? readTextOffset(e.textOffset) : undefined);
  const position = textOffset === undefined ? {} : { textOffset };
  // Bootstrap can replay older progress after a terminal durable row was read.
  if (existing && existing.status !== "running") return tools;

  if (family === "agent-draft") {
    const parsed = Option.getOrNull(Schema.decodeUnknownOption(AgentDraftToolEnvelope)(envelope));
    if (!parsed || (existing && parsed.phase === "start")) return tools;
    const result = parsed.phase === "result" ? projectAgentDraftResult(parsed) : undefined;
    const next: AgentDraftToolActivity = {
      family,
      ...position,
      callId: parsed.callId,
      name: parsed.name,
      turnIndex: existing?.turnIndex ?? (parsed.phase === "start" ? parsed.turnIndex : 0),
      callIndex:
        existing?.callIndex ?? (parsed.phase === "start" ? parsed.callIndex : tools.length),
      status: result ? (agentDraftResultOk(result) ? "complete" : "error") : "running",
      ...(result ? { result } : {}),
      ...(parsed.phase === "result" && parsed.reason ? { error: parsed.reason } : {}),
    };
    return index === -1
      ? [...tools, next]
      : tools.map((activity, i) => (i === index ? next : activity));
  }
  if (family === "schedule-draft") {
    const parsed = Option.getOrNull(
      Schema.decodeUnknownOption(ScheduleDraftToolEnvelope)(envelope),
    );
    if (!parsed || (existing && parsed.phase === "start")) return tools;
    const result = parsed.phase === "result" ? projectScheduleDraftResult(parsed) : undefined;
    const next: ScheduleDraftToolActivity = {
      family,
      ...position,
      callId: parsed.callId,
      name: parsed.name,
      turnIndex: existing?.turnIndex ?? (parsed.phase === "start" ? parsed.turnIndex : 0),
      callIndex:
        existing?.callIndex ?? (parsed.phase === "start" ? parsed.callIndex : tools.length),
      status: result ? (scheduleDraftResultOk(result) ? "complete" : "error") : "running",
      ...(result ? { result } : {}),
      ...(parsed.phase === "result" && parsed.reason ? { error: parsed.reason } : {}),
    };
    return index === -1
      ? [...tools, next]
      : tools.map((activity, i) => (i === index ? next : activity));
  }
  if (isOfficeFamily(family)) {
    const parsed = Option.getOrNull(
      Schema.decodeUnknownOption(OFFICE_FAMILIES[family].envelope)(envelope),
    );
    if (!parsed || (existing && parsed.phase === "start")) return tools;
    const next = {
      family,
      ...position,
      callId: parsed.callId,
      name: parsed.name,
      turnIndex: existing?.turnIndex ?? (parsed.phase === "start" ? parsed.turnIndex : 0),
      callIndex:
        existing?.callIndex ?? (parsed.phase === "start" ? parsed.callIndex : tools.length),
      status:
        parsed.phase === "start" ? "running" : parsed.outcome === "error" ? "error" : "complete",
      ...(parsed.phase === "result"
        ? (({
            v: _v,
            family: _family,
            phase: _phase,
            callId: _callId,
            name: _name,
            ...summary
          }) => ({
            ...summary,
            ...(summary.outcome === "error" ? { error: summary.message } : {}),
          }))(parsed)
        : {}),
    } as OfficeActivity;
    return index === -1
      ? [...tools, next]
      : tools.map((activity, i) => (i === index ? next : activity));
  }
  if (family === "tool-file") {
    const parsed = Option.getOrNull(Schema.decodeUnknownOption(ToolFileEnvelope)(envelope));
    if (!parsed || (existing && parsed.phase === "start")) return tools;
    const next: ToolFileActivity = {
      family,
      ...position,
      callId: parsed.callId,
      name: parsed.name,
      turnIndex: existing?.turnIndex ?? (parsed.phase === "start" ? parsed.turnIndex : 0),
      callIndex:
        existing?.callIndex ?? (parsed.phase === "start" ? parsed.callIndex : tools.length),
      status: parsed.phase === "start" ? "running" : parsed.ok ? "complete" : "error",
      ...(parsed.phase === "result" && parsed.attachmentId
        ? { attachmentId: parsed.attachmentId }
        : {}),
      ...(parsed.phase === "result" && parsed.workingFileId
        ? { workingFileId: parsed.workingFileId }
        : {}),
      ...(parsed.phase === "result" && parsed.error ? { error: parsed.error } : {}),
    };
    return index === -1
      ? [...tools, next]
      : tools.map((activity, i) => (i === index ? next : activity));
  }
  if (family === "custom") {
    const parsed = Option.getOrNull(Schema.decodeUnknownOption(CustomToolEnvelope)(envelope));
    if (!parsed || (existing && parsed.phase === "start")) return tools;
    const next: CustomToolActivity = {
      family: "custom",
      ...position,
      callId: parsed.callId,
      name: parsed.name,
      displayName: parsed.displayName,
      turnIndex: existing?.turnIndex ?? (parsed.phase === "start" ? parsed.turnIndex : 0),
      callIndex:
        existing?.callIndex ?? (parsed.phase === "start" ? parsed.callIndex : tools.length),
      status: parsed.phase === "start" ? "running" : parsed.status,
      ...(parsed.phase === "result"
        ? {
            ...(parsed.resultPreview !== undefined ? { resultPreview: parsed.resultPreview } : {}),
            ...(parsed.resultChars !== undefined ? { resultChars: parsed.resultChars } : {}),
            ...(parsed.error ? { error: parsed.error } : {}),
            ...(parsed.fileIds?.length ? { fileIds: parsed.fileIds } : {}),
            ...(parsed.workingFiles?.length ? { workingFiles: parsed.workingFiles } : {}),
          }
        : {}),
    };
    return index === -1
      ? [...tools, next]
      : tools.map((activity, i) => (i === index ? next : activity));
  }
  if (family === "integration") {
    const parsed = Option.getOrNull(Schema.decodeUnknownOption(IntegrationToolEnvelope)(envelope));
    if (!parsed || (existing && parsed.phase === "start")) return tools;
    const previous = existing?.family === "integration" ? existing : undefined;
    const next: IntegrationToolActivity =
      parsed.phase === "start"
        ? {
            family: "integration",
            ...position,
            callId: parsed.callId,
            name: parsed.name,
            turnIndex: parsed.turnIndex,
            callIndex: parsed.callIndex,
            status: "running",
            integrationId: parsed.integrationId,
            tool: parsed.tool,
            label: parsed.label,
            access: parsed.access,
            summary: parsed.summary,
          }
        : {
            ...integrationActivityFromRow(parsed.callId, parsed.activity),
            ...position,
            turnIndex: previous?.turnIndex ?? 0,
            callIndex: previous?.callIndex ?? tools.length,
          };
    return index === -1
      ? [...tools, next]
      : tools.map((activity, i) => (i === index ? next : activity));
  }
  if (family === "document") {
    const parsed = Option.getOrNull(Schema.decodeUnknownOption(DocumentToolEnvelope)(envelope));
    if (!parsed || (existing && parsed.phase === "start")) return tools;
    const result = parsed.phase === "result" ? projectDocumentResult(parsed) : undefined;
    const next: DocumentToolActivity = {
      family,
      ...position,
      callId: parsed.callId,
      name: parsed.name,
      turnIndex: existing?.turnIndex ?? (parsed.phase === "start" ? parsed.turnIndex : 0),
      callIndex:
        existing?.callIndex ?? (parsed.phase === "start" ? parsed.callIndex : tools.length),
      status: result ? (documentResultOk(result) ? "complete" : "error") : "running",
      ...(result ? { result } : {}),
      ...(parsed.phase === "result" && parsed.reason ? { error: parsed.reason } : {}),
    };
    return index === -1
      ? [...tools, next]
      : tools.map((activity, i) => (i === index ? next : activity));
  }
  if (family === "project-file") {
    const parsed = Option.getOrNull(Schema.decodeUnknownOption(ProjectFileToolEnvelope)(envelope));
    if (!parsed || (existing && parsed.phase === "start")) return tools;
    const result = parsed.phase === "result" ? projectProjectFileResult(parsed) : undefined;
    const next: ProjectFileToolActivity = {
      family,
      ...position,
      callId: parsed.callId,
      name: parsed.name,
      turnIndex: existing?.turnIndex ?? (parsed.phase === "start" ? parsed.turnIndex : 0),
      callIndex:
        existing?.callIndex ?? (parsed.phase === "start" ? parsed.callIndex : tools.length),
      status: result ? (projectFileResultOk(result) ? "complete" : "error") : "running",
      ...(result ? { result } : {}),
      ...(parsed.phase === "result" && parsed.reason ? { error: parsed.reason } : {}),
    };
    return index === -1
      ? [...tools, next]
      : tools.map((activity, i) => (i === index ? next : activity));
  }
  if (family === "skill") {
    const parsed = Option.getOrNull(Schema.decodeUnknownOption(SkillToolEnvelope)(envelope));
    if (!parsed || (existing && parsed.phase === "start")) return tools;
    const next: SkillToolActivity = {
      family: "skill",
      ...position,
      callId: parsed.callId,
      name: parsed.name,
      skillId: parsed.skillId,
      skillName: parsed.skillName,
      path: parsed.path,
      ...(parsed.runId ? { runId: parsed.runId } : {}),
      ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
      turnIndex: existing?.turnIndex ?? (parsed.phase === "start" ? parsed.turnIndex : 0),
      callIndex:
        existing?.callIndex ?? (parsed.phase === "start" ? parsed.callIndex : tools.length),
      status: parsed.phase === "start" ? "running" : parsed.status,
      ...(parsed.phase === "result" && parsed.error ? { error: parsed.error } : {}),
    };
    return index === -1
      ? [...tools, next]
      : tools.map((activity, i) => (i === index ? next : activity));
  }
  if (family === "knowledge") {
    const parsed = Option.getOrNull(Schema.decodeUnknownOption(KnowledgeToolEnvelope)(envelope));
    if (!parsed || (existing && parsed.phase === "start")) return tools;
    const next: KnowledgeToolActivity = {
      family: "knowledge",
      ...position,
      callId: parsed.callId,
      name: parsed.name,
      ...(parsed.runId ? { runId: parsed.runId } : {}),
      ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
      turnIndex: existing?.turnIndex ?? (parsed.phase === "start" ? parsed.turnIndex : 0),
      callIndex:
        existing?.callIndex ?? (parsed.phase === "start" ? parsed.callIndex : tools.length),
      status: parsed.phase === "start" ? "running" : parsed.ok ? "complete" : "error",
      // A running search names its queries from the start envelope; the
      // result replaces this with the full summary.
      ...(parsed.phase === "start" && parsed.targets
        ? {
            summary: {
              targets: parsed.targets,
              documentsListed: 0,
              passagesReturned: 0,
              remainingOps: 0,
              coverage: "",
            },
          }
        : {}),
      ...(parsed.phase === "result"
        ? {
            summary: parsed.summary,
            sources: [...parsed.sources],
            ...(parsed.error ? { error: parsed.error } : {}),
          }
        : {}),
    };
    return index === -1
      ? [...tools, next]
      : tools.map((activity, i) => (i === index ? next : activity));
  }

  if (family === "desktop") {
    const decodedResult =
      e.phase === "result"
        ? Option.getOrNull(Schema.decodeUnknownOption(DesktopToolResult)(e.result))
        : null;
    // A result that does not decode leaves the activity alone rather than
    // dropping it to a state the transcript cannot explain.
    if (e.phase === "result" && !decodedResult) return tools;
    if (!Schema.is(DesktopToolName)(e.name)) return tools;
    const next: DesktopToolActivity = {
      family: "desktop",
      ...position,
      callId: e.callId,
      name: e.name,
      turnIndex: existing?.turnIndex ?? e.turnIndex ?? 0,
      callIndex: existing?.callIndex ?? e.callIndex ?? 0,
      status: decodedResult ? (decodedResult.ok ? "complete" : "error") : "running",
      ...(e.args && typeof e.args === "object"
        ? { args: e.args as Record<string, unknown> }
        : existing?.family === "desktop" && existing.args
          ? { args: existing.args }
          : {}),
      ...(decodedResult ? { result: decodedResult } : {}),
    };
    return index === -1
      ? [...tools, next]
      : tools.map((activity, i) => (i === index ? next : activity));
  }

  if (family === "research") {
    const progress = readResearchProgress(e.progress);
    if (
      !progress ||
      e.name !== "deep_research" ||
      // The row id and the run id are different things: the call is minted by
      // the stream observer, the run by the handler it released. Only the
      // envelope's own `runId` correlates with the progress it carries.
      (e.runId !== undefined && e.runId !== progress.runId) ||
      (e.phase !== "start" && e.phase !== "progress" && e.phase !== "result")
    )
      return tools;
    if (existing && e.phase === "start") return tools;
    const failed = ["error", "interrupted", "aborted"].includes(progress.phase);
    const next: ResearchToolActivity = {
      family: "research",
      ...position,
      callId: e.callId,
      name: e.name,
      runId: progress.runId,
      turnIndex: existing?.turnIndex ?? e.turnIndex ?? 0,
      callIndex: existing?.callIndex ?? e.callIndex ?? 0,
      status: e.phase === "result" ? (failed ? "error" : "complete") : "running",
      progress,
      ...(e.sources
        ? { sources: e.sources }
        : existing?.family === "research" && existing.sources
          ? { sources: existing.sources }
          : {}),
    };
    return index === -1
      ? [...tools, next]
      : tools.map((activity, i) => (i === index ? next : activity));
  }

  if (family === "ask") {
    if (
      typeof e.callId !== "string" ||
      e.name !== "ask_user" ||
      (e.phase !== "start" && e.phase !== "result")
    )
      return tools;
    // The durable result is immutable. Late/replayed chunks cannot replace it.
    if (existing && (e.phase === "start" || existing.status !== "running")) return tools;
    const questions = e.phase === "result" ? readPresentedQuestions(e.result) : null;
    const next: AskToolActivity = {
      family: "ask",
      ...position,
      callId: e.callId,
      name: e.name,
      turnIndex: existing?.turnIndex ?? e.turnIndex ?? 0,
      callIndex: existing?.callIndex ?? e.callIndex ?? tools.length,
      status: e.phase === "start" ? "running" : questions ? "complete" : "error",
      ...(questions ? { questions } : {}),
    };
    return index === -1
      ? [...tools, next]
      : tools.map((activity, activityIndex) => (activityIndex === index ? next : activity));
  }

  if (family === "map") {
    if (
      e.name !== "map_route" ||
      (e.phase !== "start" && e.phase !== "result") ||
      (existing && e.phase === "start")
    )
      return tools;
    const route =
      e.phase === "result"
        ? Option.getOrUndefined(Schema.decodeUnknownOption(MapRouteSummary)(e.route))
        : undefined;
    const next: MapToolActivity = {
      family: "map",
      ...position,
      callId: e.callId,
      name: e.name,
      turnIndex: existing?.turnIndex ?? e.turnIndex ?? 0,
      callIndex: existing?.callIndex ?? e.callIndex ?? tools.length,
      status: e.phase === "start" ? "running" : e.ok && route ? "complete" : "error",
      ...(route ? { route } : {}),
    };
    return index === -1
      ? [...tools, next]
      : tools.map((activity, activityIndex) => (activityIndex === index ? next : activity));
  }

  if (family === "attachment") {
    if (e.name !== "read_attachment" || (e.phase !== "start" && e.phase !== "result")) return tools;
    if (existing && e.phase === "start") return tools;
    const read =
      e.phase === "result"
        ? Option.getOrNull(Schema.decodeUnknownOption(AttachmentReadActivity)(e))
        : null;
    const next: AttachmentToolActivity = {
      family: "attachment",
      ...position,
      callId: e.callId,
      name: e.name,
      turnIndex: existing?.turnIndex ?? e.turnIndex ?? 0,
      callIndex: existing?.callIndex ?? e.callIndex ?? tools.length,
      status: e.phase === "start" ? "running" : read?.ok ? "complete" : "error",
      ...(read ? { read } : {}),
    };
    return index === -1
      ? [...tools, next]
      : tools.map((activity, activityIndex) => (activityIndex === index ? next : activity));
  }

  if (family === "tool-load") {
    if (e.name !== "load_tools" || (e.phase !== "start" && e.phase !== "result")) return tools;
    if (existing && e.phase === "start") return tools;
    const loaded =
      e.phase === "result"
        ? Option.getOrNull(
            Schema.decodeUnknownOption(Schema.Array(LazyToolFamily))(
              (e as { loaded?: unknown }).loaded ?? null,
            ),
          )
        : null;
    const next: ToolLoadActivity = {
      family: "tool-load",
      ...position,
      callId: e.callId,
      name: e.name,
      turnIndex: existing?.turnIndex ?? e.turnIndex ?? 0,
      callIndex: existing?.callIndex ?? e.callIndex ?? tools.length,
      status: e.phase === "start" ? "running" : e.ok && loaded ? "complete" : "error",
      ...(loaded ? { loaded } : {}),
    };
    return index === -1
      ? [...tools, next]
      : tools.map((activity, activityIndex) => (activityIndex === index ? next : activity));
  }

  if (family === "notify") {
    if (
      e.name !== "notify_user" ||
      (e.phase !== "start" && e.phase !== "result") ||
      (e.phase === "result" && typeof e.ok !== "boolean") ||
      (existing && e.phase === "start")
    )
      return tools;
    const message =
      e.phase === "result" && typeof (e as { message?: unknown }).message === "string"
        ? (e as { message: string }).message
        : undefined;
    const next: NotifyToolActivity = {
      family: "notify",
      ...position,
      callId: e.callId,
      name: e.name,
      turnIndex: existing?.turnIndex ?? e.turnIndex ?? 0,
      callIndex: existing?.callIndex ?? e.callIndex ?? tools.length,
      status: e.phase === "start" ? "running" : e.ok && message ? "complete" : "error",
      ...(message ? { message } : {}),
    };
    return index === -1
      ? [...tools, next]
      : tools.map((activity, activityIndex) => (activityIndex === index ? next : activity));
  }

  if (family === "plan") {
    if (
      e.name !== "update_plan" ||
      (e.phase !== "start" && e.phase !== "result") ||
      (e.phase === "result" && typeof e.ok !== "boolean")
    )
      return tools;
    // A terminal row stays terminal; a later call is its own activity, and the
    // list it carries is the whole current checklist.
    if (existing && (e.phase === "start" || existing.status !== "running")) return tools;
    const steps =
      e.phase === "result"
        ? Option.getOrNull(
            Schema.decodeUnknownOption(Schema.Array(PlanStep))(
              (e as { steps?: unknown }).steps ?? null,
            ),
          )
        : null;
    const next: PlanToolActivity = {
      family: "plan",
      ...position,
      callId: e.callId,
      name: e.name,
      turnIndex: existing?.turnIndex ?? e.turnIndex ?? 0,
      callIndex: existing?.callIndex ?? e.callIndex ?? tools.length,
      status: e.phase === "start" ? "running" : e.ok && steps ? "complete" : "error",
      ...(steps ? { steps } : {}),
    };
    return index === -1
      ? [...tools, next]
      : tools.map((activity, activityIndex) => (activityIndex === index ? next : activity));
  }

  if (family === "memory") {
    if (e.phase === "start") {
      if (existing) return tools;
      return [
        ...tools,
        {
          family: "memory",
          ...position,
          callId: e.callId,
          name: e.name,
          turnIndex: e.turnIndex ?? 0,
          callIndex: e.callIndex ?? tools.length,
          status: "running",
        },
      ];
    }
    if (e.phase !== "result" || typeof e.ok !== "boolean") return tools;

    const outcome = toMemoryActivityOutcome(e.summary?.outcome ?? e.outcome);
    const reason = toMemoryActivityReason(e.reason);
    const next: MemoryToolActivity = {
      family: "memory",
      ...position,
      callId: e.callId,
      name: e.name,
      turnIndex: existing?.turnIndex ?? e.turnIndex ?? 0,
      callIndex: existing?.callIndex ?? e.callIndex ?? tools.length,
      status: e.ok ? "complete" : "error",
      ...(outcome ? { outcome } : {}),
      ...(reason ? { reason } : {}),
      ...(e.scope === "project" ? { scope: "project" as const } : {}),
      ...(typeof e.error === "string" ? { error: e.error } : {}),
    };
    return index === -1
      ? [...tools, next]
      : tools.map((activity, activityIndex) => (activityIndex === index ? next : activity));
  }

  const upsertWeb = (next: Partial<WebToolActivity>): ToolActivity[] => {
    const activity: WebToolActivity = {
      family: "web",
      ...position,
      ...(existing?.runId
        ? { runId: existing.runId }
        : typeof e.runId === "string"
          ? { runId: e.runId }
          : {}),
      ...(existing?.taskId
        ? { taskId: existing.taskId }
        : typeof e.taskId === "string"
          ? { taskId: e.taskId }
          : {}),
      callId: e.callId!,
      name: e.name!,
      turnIndex: existing?.turnIndex ?? e.turnIndex ?? 0,
      callIndex: existing?.callIndex ?? e.callIndex ?? tools.length,
      targets: existing && isWebToolActivity(existing) ? existing.targets : [],
      status: existing?.status ?? "running",
      ...next,
    };
    return index === -1
      ? [...tools, activity]
      : tools.map((current, activityIndex) => (activityIndex === index ? activity : current));
  };

  if (e.phase === "start") {
    if (existing) return tools;
    return upsertWeb({
      targets: e.args?.targets ?? [],
      status: "running",
    });
  }
  if (e.phase === "progress") {
    return upsertWeb({
      status: "running",
      ...(e.summary?.targets ? { targets: e.summary.targets } : {}),
      ...(e.summary?.resultCount !== undefined ? { resultCount: e.summary.resultCount } : {}),
      ...(e.pages !== undefined ? { pages: e.pages } : {}),
    });
  }
  if (e.phase === "result" && typeof e.ok === "boolean") {
    return upsertWeb({
      targets: e.summary?.targets ?? [],
      status: e.ok ? "complete" : "error",
      ...(e.summary?.resultCount !== undefined ? { resultCount: e.summary.resultCount } : {}),
      ...(e.summary?.pagesFetched !== undefined ? { pagesFetched: e.summary.pagesFetched } : {}),
      ...(e.pages !== undefined ? { pages: e.pages } : {}),
      ...(e.sources !== undefined ? { sources: e.sources } : {}),
      ...(typeof e.error === "string" ? { error: e.error } : {}),
    });
  }
  return tools;
}

/**
 * Same defensive contract as `applyToolChunk`: a malformed envelope leaves the
 * state alone, and replaying the same marker twice is a no-op.
 */
export function applyCompactionChunk(
  current: CompactionActivity[],
  delta: string,
): CompactionActivity[] {
  let envelope: unknown;
  try {
    envelope = JSON.parse(delta);
  } catch {
    return current;
  }
  if (typeof envelope !== "object" || envelope === null) return current;
  const e = envelope as {
    textOffset?: unknown;
    v?: number;
    phase?: string;
    eventId?: string;
    runId?: string;
    taskId?: string;
    beforeTurnIndex?: number;
    passIndex?: number;
    scope?: "history" | "active_rounds";
    ok?: boolean;
    outcome?: "summary" | "hard_truncation";
    summary?: string;
  };
  if (
    e.v !== 1 ||
    !e.eventId ||
    e.beforeTurnIndex === undefined ||
    e.passIndex === undefined ||
    !e.scope
  ) {
    return current;
  }

  const index = current.findIndex((activity) => activity.eventId === e.eventId);
  const existing = index === -1 ? undefined : current[index];
  if (existing && existing.status !== "running") return current;
  const textOffset = existing ? existing.textOffset : readTextOffset(e.textOffset);
  const next: CompactionActivity = {
    eventId: e.eventId,
    ...(existing?.runId
      ? { runId: existing.runId }
      : typeof e.runId === "string"
        ? { runId: e.runId }
        : {}),
    ...(existing?.taskId
      ? { taskId: existing.taskId }
      : typeof e.taskId === "string"
        ? { taskId: e.taskId }
        : {}),
    ...(textOffset === undefined ? {} : { textOffset }),
    beforeTurnIndex: existing?.beforeTurnIndex ?? e.beforeTurnIndex,
    passIndex: existing?.passIndex ?? e.passIndex,
    scope: existing?.scope ?? e.scope,
    status: e.phase === "result" ? (e.ok ? "complete" : "failed") : (existing?.status ?? "running"),
    ...(e.outcome
      ? { outcome: e.outcome }
      : existing?.outcome
        ? { outcome: existing.outcome }
        : {}),
    ...(typeof e.summary === "string"
      ? { summary: e.summary }
      : existing?.summary
        ? { summary: existing.summary }
        : {}),
  };
  if (e.phase !== "start" && e.phase !== "result") return current;
  const activities =
    index === -1
      ? [...current, next]
      : current.map((activity, i) => (i === index ? next : activity));
  // oxlint-disable-next-line no-array-sort -- fresh array
  return [...activities].sort(
    (a, b) => a.beforeTurnIndex - b.beforeTurnIndex || a.passIndex - b.passIndex,
  );
}

/** Every chunk kind the server writes; see `ChunkKind` in the chat repo. */
type ChunkKind = "text" | "reasoning" | "tool" | "compaction" | "file" | "steer" | "writing";

/** Adds a steer from its envelope; a replayed or malformed one changes nothing. */
export const applySteerChunk = (
  steers: ReadonlyArray<AssistantSteer>,
  delta: string,
): AssistantSteer[] => {
  try {
    const { v: _version, ...steer } = Schema.decodeUnknownSync(SteerChunkEnvelope)(
      JSON.parse(delta),
    );
    if (steers.some((item) => item.id === steer.id)) return [...steers];
    return [...steers, steer];
  } catch {
    return [...steers];
  }
};

export const applyFileChunk = (
  files: ReadonlyArray<AssistantFile>,
  delta: string,
): AssistantFile[] => {
  try {
    const file = Schema.decodeUnknownSync(AssistantFile)(JSON.parse(delta));
    if (
      files.some((item) => item.attachment.id === file.attachment.id) ||
      files.length >= ASSISTANT_FILE_LIMITS.count
    )
      return [...files];
    return [...files, file];
  } catch {
    return [...files];
  }
};

/** A call still being written leaves once any call starts or the answer ends. */
const withoutWriting = (tools: ReadonlyArray<ToolActivity>) =>
  tools.filter((tool) => !("writing" in tool && tool.writing));

/**
 * A writing marker from an earlier attempt of a resumed answer. That attempt
 * ended mid-call, so nothing will ever replace the marker.
 */
export const isStaleWriting = (delta: string, runId: string | null) => {
  try {
    const writing = JSON.parse(delta) as { runId?: unknown };
    return typeof writing.runId === "string" && runId !== null && writing.runId !== runId;
  } catch {
    return false;
  }
};

/** An Office edit the model has begun writing, shown as a running step until it starts. */
export const applyWritingChunk = (tools: ReadonlyArray<ToolActivity>, delta: string) => {
  try {
    const writing = JSON.parse(delta) as {
      v?: unknown;
      id?: unknown;
      name?: unknown;
      textOffset?: unknown;
      turnIndex?: unknown;
    };
    if (
      writing.v !== 1 ||
      typeof writing.id !== "string" ||
      typeof writing.name !== "string" ||
      typeof writing.textOffset !== "number" ||
      typeof writing.turnIndex !== "number"
    )
      return [...tools];
    // A long call the model spends a while writing: an Office edit, or a
    // research brief, which otherwise shows nothing until the run starts.
    const position = {
      name: writing.name,
      callId: `writing:${writing.id}`,
      status: "running" as const,
      textOffset: writing.textOffset,
      turnIndex: writing.turnIndex,
      callIndex: Number.MAX_SAFE_INTEGER,
      writing: true as const,
    };
    const family = officeFamilyOfEdit(writing.name);
    if (family) return [...withoutWriting(tools), { ...position, family }];
    if (writing.name === "deep_research")
      return [...withoutWriting(tools), { ...position, family: "research" as const }];
    return [...tools];
  } catch {
    return [...tools];
  }
};

const startsCall = (delta: string) => {
  try {
    return (JSON.parse(delta) as { phase?: unknown }).phase === "start";
  } catch {
    return false;
  }
};

/**
 * Tool times are the server's clock: a live chunk is stamped as it is sent, a
 * replayed one and a stored row with when they were written. Elapsed time is
 * read against the server's clock too, so a skewed browser clock cannot
 * shift a running timer after a reload. Learned from each stream frame and
 * conversation snapshot.
 */
let clockOffset = 0;
export const learnServerClock = (serverTime: number, receivedAt = Date.now()) => {
  clockOffset = receivedAt - serverTime;
};
export const serverNow = () => Date.now() - clockOffset;

/**
 * Keeps each call's timing across a chunk: the family reducers rebuild their
 * activity without it, so it is carried over, then a new call is stamped
 * started and one that just settled stamped completed.
 */
export const stampToolTimes = (
  before: ReadonlyArray<ToolActivity>,
  after: ToolActivity[],
  now: number,
): ToolActivity[] => {
  const previous = new Map(before.map((activity) => [activity.callId, activity]));
  return after.map((activity) => {
    const prior = previous.get(activity.callId);
    if (prior === activity) return activity;
    const startedAt = activity.startedAt ?? prior?.startedAt ?? now;
    const completedAt =
      activity.completedAt ??
      prior?.completedAt ??
      (activity.status === "running" ? undefined : now);
    return {
      ...activity,
      startedAt,
      ...(completedAt === undefined ? {} : { completedAt }),
    };
  });
};

/** Tool and writing chunks in stream order, for the live reducer and a reload's replay alike. */
export const applyToolActivityChunk = (
  tools: ReadonlyArray<ToolActivity>,
  kind: "tool" | "writing",
  delta: string,
  at = serverNow(),
): ToolActivity[] =>
  kind === "writing"
    ? applyWritingChunk(tools, delta)
    : stampToolTimes(
        tools,
        applyToolChunk(startsCall(delta) ? withoutWriting(tools) : [...tools], delta),
        at,
      );

type StateChunkKind = Extract<Action, { kind: "chunk" }>["chunkKind"];

function applyChunk(
  state: StreamState,
  kind: StateChunkKind,
  delta: string,
  at?: number,
): StreamState {
  switch (kind) {
    case "file":
      return { ...state, files: applyFileChunk(state.files, delta) };
    case "compaction":
      return { ...state, compactions: applyCompactionChunk(state.compactions, delta) };
    case "steer":
      return { ...state, steers: applySteerChunk(state.steers, delta) };
    case "writing":
    case "tool":
      return { ...state, tools: applyToolActivityChunk(state.tools, kind, delta, at) };
  }
}

function reducer(state: StreamState, action: Action): StreamState {
  switch (action.kind) {
    case "reset":
      return {
        files: action.files ?? [],
        tools: action.tools,
        compactions: action.compactions,
        steers: action.steers ?? [],
        status: "streaming",
        reading: null,
        lookups: action.lookups ?? NO_LOOKUPS,
      };
    case "chunk":
      return applyChunk(state, action.chunkKind, action.delta, action.at);
    case "reading":
      return { ...state, reading: action.reading };
    case "lookups":
      // Each event restates every result so far, so a repeat changes nothing.
      return { ...state, lookups: mergeLookups(state.lookups, action.lookups) };
    case "done":
      return {
        ...state,
        tools: withoutWriting(state.tools),
        status: action.status,
        reading: null,
      };
  }
}

export interface InitialStream {
  files?: AssistantFile[];
  text: string;
  reasoning: string;
  reasoningSeen: boolean;
  tools: ToolActivity[];
  compactions: CompactionActivity[];
  steers?: AssistantSteer[];
  lookups?: UiLookups;
  lastSeq: number;
}

const liveTextFrom = (initial: InitialStream | null): LiveText =>
  createLiveText({
    text: initial?.text ?? "",
    reasoning: initial?.reasoning ?? "",
    reasoningSeen: initial?.reasoningSeen ?? false,
    lastSeq: initial?.lastSeq ?? 0,
  });

/**
 * Subscribes to a streaming assistant message with resume support.
 * `initial` carries chunks already loaded via the conversation query, so the
 * SSE connection only replays what happened after them (?after=<seq>).
 */
export function useMessageStream(
  messageId: string | null,
  initial: InitialStream | null,
  conversationId: string | null,
  /**
   * Bump to force a fresh subscription for the SAME message id, since retry reuses
   * the row, so the id alone can't signal "this is a new generation".
   */
  epoch = 0,
  runId: string | null = null,
  canonicalStatus?: "streaming" | "complete" | "error" | "aborted",
) {
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(reducer, {
    files: initial?.files ?? [],
    tools: initial?.tools ?? [],
    compactions: initial?.compactions ?? [],
    steers: initial?.steers ?? [],
    status: messageId ? "streaming" : "idle",
    reading: null,
    lookups: initial?.lookups ?? NO_LOOKUPS,
  });
  const [live, setLive] = useState(() => liveTextFrom(initial));
  // Reset when the target generation changes (navigation between chats, or a
  // retry of the same message).
  const generationKey = `${messageId}:${runId ?? "chat"}:${epoch}`;
  const [stateGeneration, setStateGeneration] = useState(generationKey);
  // Reset before commit: a same-message retry must never paint the prior files.
  if (messageId && stateGeneration !== generationKey) {
    setStateGeneration(generationKey);
    setLive(liveTextFrom(initial));
    dispatch({
      kind: "reset",
      files: initial?.files ?? [],
      tools: initial?.tools ?? [],
      compactions: initial?.compactions ?? [],
      steers: initial?.steers ?? [],
      lookups: initial?.lookups ?? NO_LOOKUPS,
    });
  }
  const activeRef = useRef<string | null>(null);
  const terminalFailure =
    canonicalStatus === "error" || canonicalStatus === "aborted" ? canonicalStatus : null;

  useEffect(() => {
    if (!messageId) {
      activeRef.current = null;
      return;
    }
    activeRef.current = generationKey;
    // A reaped error may reach detail before this tab gets its SSE terminal
    // event. Successful detail can precede the last tool chunks, so keep its
    // subscription alive until the stream delivers those and its done marker.
    if (terminalFailure) {
      dispatch({ kind: "done", status: terminalFailure });
      return;
    }

    const after = initial?.lastSeq ?? 0;
    const source = new EventSource(
      `/api/messages/${messageId}/stream?after=${after}${runId ? `&runId=${encodeURIComponent(runId)}` : ""}`,
    );
    let closed = false;
    const acceptsRun = (eventRunId: string | undefined) => {
      if (closed || activeRef.current !== generationKey) return false;
      if ((eventRunId ?? null) === runId) return true;
      closed = true;
      source.close();
      if (conversationId)
        void queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
      return false;
    };

    source.addEventListener("chunk", (raw) => {
      const data = JSON.parse((raw as MessageEvent).data) as {
        seq: number;
        kind?: ChunkKind;
        delta: string;
        runId?: string;
        at?: number;
        sentAt?: number;
      };
      if (data.sentAt !== undefined) learnServerClock(data.sentAt);
      if (!acceptsRun(data.runId) || !live.claim(data.seq)) return;
      const chunkKind = data.kind ?? "text";
      if (chunkKind === "writing" && isStaleWriting(data.delta, runId)) return;
      if (chunkKind === "text" || chunkKind === "reasoning") live.append(chunkKind, data.delta);
      else
        dispatch({
          kind: "chunk",
          chunkKind,
          delta: data.delta,
          ...(data.at === undefined ? {} : { at: data.at }),
        });
      if (data.kind === "tool") {
        const activity = applyToolChunk([], data.delta, "document").at(0);
        if (activity?.family === "document" && activity.result?.documentId)
          void queryClient.invalidateQueries({
            queryKey: ["documents", activity.result.documentId],
          });
      }
    });

    source.addEventListener("status", (raw) => {
      const data = JSON.parse((raw as MessageEvent).data) as {
        reading: StreamState["reading"];
        runId?: string;
      };
      if (!acceptsRun(data.runId)) return;
      dispatch({ kind: "reading", reading: data.reading });
    });

    source.addEventListener("lookups", (raw) => {
      const data = JSON.parse((raw as MessageEvent).data) as {
        lookups: UiLookups;
        runId?: string;
      };
      if (!acceptsRun(data.runId)) return;
      dispatch({ kind: "lookups", lookups: data.lookups });
    });

    source.addEventListener("done", (raw) => {
      const data = JSON.parse((raw as MessageEvent).data) as {
        status: "complete" | "error" | "aborted";
        runId?: string;
      };
      if (!acceptsRun(data.runId)) return;
      closed = true;
      dispatch({ kind: "done", status: data.status });
      source.close();
      // Errors and stops refresh the canonical row immediately, since feedback
      // outranks pacing. A normal completion holds the refetch until the
      // smoothed view drains (the effect below): swapping in the row's full
      // content early would be exactly the end-of-stream pop smoothing
      // exists to remove.
      if (data.status !== "complete" && conversationId) {
        void queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
      }
    });

    source.addEventListener("error", () => {
      // EventSource auto-reconnects; nothing to do. If the server is gone the
      // browser keeps retrying, which is the desired resume behavior.
    });

    return () => {
      closed = true;
      source.close();
    };
    // initial is intentionally captured only when the generation changes
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the resume point is read once, when this generation subscribes
  }, [messageId, epoch, runId, terminalFailure, conversationId, queryClient, generationKey, live]);

  // Completion is only reported once the words are all on screen; the pacer
  // keeps advancing regardless of status, so this converges within ticks of
  // the real finish. Errors and stops pass through undelayed. Read only once
  // complete, so a display catching up mid-stream re-renders nothing here.
  const complete = state.status === "complete";
  const drained = useSyncExternalStore(
    live.subscribe,
    () => !complete || live.getSnapshot().drained,
    () => true,
  );

  // Deferred half of the done handler: once the display has caught up,
  // refresh the canonical message row (final content, usage, status). The
  // messageId guard keeps the refetch from re-firing after it lands (the
  // streaming row disappears, so messageId goes null) or on navigation.
  useEffect(() => {
    if (!complete || !drained || !messageId || !conversationId) return;
    void queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
  }, [complete, drained, messageId, conversationId, queryClient]);

  return {
    ...state,
    /** The answer and reasoning text; only the row drawing them subscribes. */
    live,
    status: complete && !drained ? ("streaming" as const) : state.status,
  };
}

/** A finished integration row, live or reloaded; both read the same projection. */
export const integrationActivityFromRow = (
  callId: string,
  activity: import("~/modules/integrations/tool-schema.ts").IntegrationToolActivity,
): IntegrationToolActivity => ({
  family: "integration",
  callId,
  name: activity.name,
  status: activity.status === "complete" ? "complete" : "error",
  integrationId: activity.integrationId,
  tool: activity.tool,
  label: activity.label,
  access: activity.access,
  summary: activity.summary,
  ...(activity.status === "refused" ? { refused: true } : {}),
  ...(activity.error ? { error: activity.error } : {}),
  ...(activity.link ? { link: activity.link } : {}),
  ...(activity.sources?.length ? { sources: activity.sources } : {}),
});
