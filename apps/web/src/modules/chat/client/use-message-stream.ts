import {
  AgentDraftToolEnvelope,
  projectAgentDraftResult,
  agentDraftResultOk,
  type AgentDraftActivityResult,
} from "~/modules/agents/tool-schema.ts";
import { SkillToolEnvelope } from "~/modules/skills/tool-schema.ts";
import { AssistantImage, IMAGE_OUTPUT_LIMITS } from "../assistant-output.ts";
import {
  KnowledgeToolEnvelope,
  type KnowledgeActivitySummary,
} from "~/modules/knowledge/tool-schema.ts";
import { useQueryClient } from "@tanstack/react-query";
import { Option, Schema } from "effect";
import { ResearchProgress } from "../research-schema.ts";
import { DesktopToolName, DesktopToolResult } from "~/modules/desktop/tool-schema.ts";
import { useEffect, useReducer, useRef, useState } from "react";
import { useSmoothText } from "./use-smooth-text.ts";
import { MemoryActivityReason, type MemoryActivityOutcome } from "~/modules/tools/schema.ts";
import { readPresentedQuestions, type AskUserQuestion } from "~/modules/tools/ask-user-schema.ts";
import { PlanStep } from "~/modules/tools/plan-schema.ts";

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
}

// Live/durable view of one web tool call, upserted by callId from tool chunks.
export interface WebToolActivity extends ToolActivityBase {
  family: "web";
  targets: string[];
  resultCount?: number;
  pagesFetched?: number;
  pages?: ToolPageStatus[];
  sources?: ToolSource[];
}

// Memory activity is deliberately summary-only. User memory content and every
// web-only field stay out of both stream state and the rendered activity row.
export interface MemoryToolActivity extends ToolActivityBase {
  family: "memory";
  outcome?: MemoryActivityOutcome;
  /** Why a save was refused; only ever one of the handler's fixed reasons. */
  reason?: MemoryActivityReason;
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
}

export const readResearchProgress = (value: unknown): ResearchProgress | null =>
  Option.getOrNull(Schema.decodeUnknownOption(ResearchProgress)(value));

export interface AgentDraftToolActivity extends ToolActivityBase {
  family: "agent-draft";
  result?: AgentDraftActivityResult;
}

export interface DesktopToolActivity extends ToolActivityBase {
  family: "desktop";
  /** Narrowed from the base so the transcript can switch on it exhaustively. */
  name: DesktopToolName;
  /** Present from `start`, because the page is what executes the call. */
  args?: Record<string, unknown>;
  result?: DesktopToolResult;
}

export type ToolActivity =
  | AgentDraftToolActivity
  | DesktopToolActivity
  | WebToolActivity
  | MemoryToolActivity
  | AskToolActivity
  | PlanToolActivity
  | ResearchToolActivity
  | KnowledgeToolActivity
  | SkillToolActivity;

export const isWebToolActivity = (activity: ToolActivity): activity is WebToolActivity =>
  activity.family === "web";

export const isMemoryToolActivity = (activity: ToolActivity): activity is MemoryToolActivity =>
  activity.family === "memory";

// One durable/live compaction occurrence. Position is relative to model/tool
// turns inside this assistant response, not to the historical checkpoint it
// may have produced.
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

export interface StreamState {
  images: AssistantImage[];
  /** Visible answer text accumulated from chunks. */
  text: string;
  /** Reasoning/thinking text; stays empty for hidden-reasoning providers. */
  reasoning: string;
  /** True once any reasoning chunk arrived (even empty hidden markers). */
  reasoningSeen: boolean;
  tools: ToolActivity[];
  /** Usually empty; one response may compact at several turn boundaries. */
  compactions: CompactionActivity[];
  lastSeq: number;
  status: "idle" | "streaming" | "complete" | "error" | "aborted";
}

type Action =
  | {
      kind: "reset";
      images?: AssistantImage[];
      text: string;
      reasoning: string;
      reasoningSeen: boolean;
      tools: ToolActivity[];
      compactions: CompactionActivity[];
      lastSeq: number;
    }
  | {
      kind: "chunk";
      seq: number;
      chunkKind: "text" | "reasoning" | "tool" | "compaction" | "image";
      delta: string;
    }
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

// Parses a tool chunk envelope defensively: malformed rows must not crash the
// stream; the chunk still advances lastSeq so resume cursors stay correct.
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
    outcome?: unknown;
    reason?: unknown;
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
    e.family !== "web" &&
    e.family !== "memory" &&
    e.family !== "ask" &&
    e.family !== "plan" &&
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
      progress.runId !== e.callId ||
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

// Same defensive contract as `applyToolChunk`: a malformed envelope leaves the
// state alone, and replaying the same marker twice is a no-op.
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

export const applyImageChunk = (
  images: ReadonlyArray<AssistantImage>,
  delta: string,
): AssistantImage[] => {
  try {
    const image = Schema.decodeUnknownSync(AssistantImage)(JSON.parse(delta));
    if (
      images.some((item) => item.attachment.id === image.attachment.id) ||
      images.length >= IMAGE_OUTPUT_LIMITS.count
    )
      return [...images];
    return [...images, image];
  } catch {
    return [...images];
  }
};

function reducer(state: StreamState, action: Action): StreamState {
  switch (action.kind) {
    case "reset":
      return {
        images: action.images ?? [],
        text: action.text,
        reasoning: action.reasoning,
        reasoningSeen: action.reasoningSeen,
        tools: action.tools,
        compactions: action.compactions,
        lastSeq: action.lastSeq,
        status: "streaming",
      };
    case "chunk": {
      if (action.seq <= state.lastSeq) return state;
      if (action.chunkKind === "image")
        return {
          ...state,
          images: applyImageChunk(state.images, action.delta),
          lastSeq: action.seq,
        };
      if (action.chunkKind === "reasoning") {
        return {
          ...state,
          reasoning: state.reasoning + action.delta,
          reasoningSeen: true,
          lastSeq: action.seq,
        };
      }
      if (action.chunkKind === "compaction") {
        return {
          ...state,
          compactions: applyCompactionChunk(state.compactions, action.delta),
          lastSeq: action.seq,
        };
      }
      if (action.chunkKind === "tool") {
        return {
          ...state,
          tools: applyToolChunk(state.tools, action.delta),
          lastSeq: action.seq,
        };
      }
      return {
        ...state,
        text: state.text + (action.chunkKind === "text" ? action.delta : ""),
        lastSeq: action.seq,
      };
    }
    case "done":
      return { ...state, status: action.status };
  }
}

export interface InitialStream {
  images?: AssistantImage[];
  text: string;
  reasoning: string;
  reasoningSeen: boolean;
  tools: ToolActivity[];
  compactions: CompactionActivity[];
  lastSeq: number;
}

// Subscribes to a streaming assistant message with resume support.
// `initial` carries chunks already loaded via the conversation query, so the
// SSE connection only replays what happened after them (?after=<seq>).
export function useMessageStream(
  messageId: string | null,
  initial: InitialStream | null,
  conversationId: string | null,
  /**
   * Bump to force a fresh subscription for the SAME message id — retry reuses
   * the row, so the id alone can't signal "this is a new generation".
   */
  epoch = 0,
  runId: string | null = null,
) {
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(reducer, {
    images: initial?.images ?? [],
    text: initial?.text ?? "",
    reasoning: initial?.reasoning ?? "",
    reasoningSeen: initial?.reasoningSeen ?? false,
    tools: initial?.tools ?? [],
    compactions: initial?.compactions ?? [],
    lastSeq: initial?.lastSeq ?? 0,
    status: messageId ? "streaming" : "idle",
  });
  // Reset when the target generation changes (navigation between chats, or a
  // retry of the same message).
  const generationKey = `${messageId}:${runId ?? "chat"}:${epoch}`;
  const [stateGeneration, setStateGeneration] = useState(generationKey);
  // Reset before commit: a same-message retry must never paint the prior images.
  if (messageId && stateGeneration !== generationKey) {
    setStateGeneration(generationKey);
    dispatch({
      kind: "reset",
      images: initial?.images ?? [],
      text: initial?.text ?? "",
      reasoning: initial?.reasoning ?? "",
      reasoningSeen: initial?.reasoningSeen ?? false,
      tools: initial?.tools ?? [],
      compactions: initial?.compactions ?? [],
      lastSeq: initial?.lastSeq ?? 0,
    });
  }
  const activeRef = useRef<string | null>(null);

  useEffect(() => {
    if (!messageId) {
      activeRef.current = null;
      return;
    }
    activeRef.current = generationKey;

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
        kind?: "text" | "reasoning" | "tool" | "compaction" | "image";
        delta: string;
        runId?: string;
      };
      if (!acceptsRun(data.runId)) return;
      dispatch({ kind: "chunk", seq: data.seq, chunkKind: data.kind ?? "text", delta: data.delta });
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
      // Errors and stops refresh the canonical row immediately — feedback
      // outranks pacing. A normal completion holds the refetch until the
      // smoothed view drains (the effect below): swapping in the row's full
      // content early would be exactly the end-of-stream pop smoothing
      // exists to remove.
      if (data.status !== "complete" && conversationId) {
        void queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
      }
    });

    source.onerror = () => {
      // EventSource auto-reconnects; nothing to do. If the server is gone the
      // browser keeps retrying, which is the desired resume behavior.
    };

    return () => {
      closed = true;
      source.close();
    };
    // initial is intentionally captured only when the generation changes
  }, [messageId, epoch, runId, conversationId, queryClient, generationKey]);

  // The reducer accumulates raw deltas (lastSeq must track receipt exactly —
  // resume depends on it); only the strings the UI renders are word-paced.
  const text = useSmoothText(state.text);
  const reasoning = useSmoothText(state.reasoning);
  const drained = text === state.text && reasoning === state.reasoning;

  // Deferred half of the done handler: once the display has caught up,
  // refresh the canonical message row (final content, usage, status). The
  // messageId guard keeps the refetch from re-firing after it lands (the
  // streaming row disappears, so messageId goes null) or on navigation.
  useEffect(() => {
    if (state.status !== "complete" || !drained || !messageId || !conversationId) return;
    void queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
  }, [state.status, drained, messageId, conversationId, queryClient]);

  return {
    ...state,
    rawTextLength: state.text.length,
    text,
    reasoning,
    // Completion is only reported once the words are all on screen; the
    // pacer keeps advancing regardless of status, so this converges within
    // ticks of the real finish. Errors and stops pass through undelayed.
    status: state.status === "complete" && !drained ? ("streaming" as const) : state.status,
  };
}
