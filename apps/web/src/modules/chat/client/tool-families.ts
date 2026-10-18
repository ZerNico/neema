import { Option, Schema } from "effect";
import {
  AgentDraftToolEnvelope,
  AgentDraftToolName,
  agentDraftResultOk,
  projectAgentDraftResult,
} from "~/modules/agents/tool-schema.ts";
import { CustomToolActivity, CustomToolEnvelope } from "~/modules/custom-tools/tool-schema.ts";
import { isCustomToolName } from "~/modules/custom-tools/schema.ts";
import { DesktopToolName, DesktopToolResult } from "~/modules/desktop/tool-schema.ts";
import {
  DocumentToolEnvelope,
  DocumentToolName,
  documentResultOk,
  projectDocumentResult,
} from "~/modules/documents/tool-schema.ts";
import {
  MAP_ROUTE_TOOL,
  MapRouteResult,
  MapRouteSummary,
  summarizeMapRoute,
} from "~/modules/genui/map-tool-schema.ts";
import {
  IMAGE_TOOL,
  ImageToolActivity,
  ImageToolEnvelope,
  runningImageActivity,
} from "~/modules/images/tool-schema.ts";
import { parseIntegrationToolName } from "~/modules/integrations/manifest.ts";
import {
  IntegrationToolActivity as StoredIntegrationActivity,
  IntegrationToolEnvelope,
} from "~/modules/integrations/tool-schema.ts";
import {
  KnowledgeActivityResult,
  KnowledgeToolEnvelope,
  KnowledgeToolName,
} from "~/modules/knowledge/tool-schema.ts";
import {
  OFFICE_FAMILIES,
  officeFamilyOfTool,
  type OfficeFamily,
} from "~/modules/office/families.ts";
import {
  ProjectFileToolEnvelope,
  ProjectFileToolName,
  projectFileResultOk,
  projectProjectFileResult,
} from "~/modules/projects/file-tool-schema.ts";
import { NotifyToolResult } from "~/modules/schedules/notify-schema.ts";
import {
  ScheduleDraftToolEnvelope,
  ScheduleDraftToolName,
  projectScheduleDraftResult,
  scheduleDraftResultOk,
} from "~/modules/schedules/tool-schema.ts";
import { SkillActivity, SkillToolEnvelope, SkillToolName } from "~/modules/skills/tool-schema.ts";
import { AskUserResult, readPresentedQuestions } from "~/modules/tools/ask-user-schema.ts";
import { PlanStep, PlanToolResult } from "~/modules/tools/plan-schema.ts";
import { MemoryActivityReason, type MemoryActivityOutcome } from "~/modules/tools/schema.ts";
import { LoadToolsResult } from "~/modules/tools/tool-load-schema.ts";
import { AttachmentReadActivity } from "../attachment-tool-schema.ts";
import { ResearchProgress } from "../research-schema.ts";
import { ToolFileActivity, ToolFileEnvelope } from "../tool-file-schema.ts";
import type {
  IntegrationToolActivity,
  ToolActivity,
  ToolPageStatus,
  ToolSource,
} from "./use-message-stream.ts";

/**
 * One table per tool family, read by the live stream and the reload alike.
 * Both turn what they have into the call its row records (`ToolCall`) and
 * hand it to the family's one `project`, so the two views cannot disagree.
 */

type Family = ToolActivity["family"];
type ActivityOf<F extends Family> = Extract<ToolActivity, { family: F }>;
/** Where a call sits and when it ran, which its reader knows and its family does not. */
type Placement =
  | "family"
  | "callId"
  | "name"
  | "turnIndex"
  | "callIndex"
  | "textOffset"
  | "startedAt"
  | "completedAt";
type FamilyFields<F extends Family> =
  ActivityOf<F> extends infer A ? (A extends unknown ? Omit<A, Placement> : never) : never;

/** One call as its `message_tool_calls` row holds it. */
export interface ToolCall {
  name: string;
  status: "running" | "complete" | "error";
  /** What the server kept of the call; a running row holds a snapshot or nothing. */
  result: unknown;
  args?: unknown;
  /** The row's error, read only where the kept result has no error of its own. */
  error?: string | undefined;
}

/** A live envelope read as the call its row records, plus what only the stream says. */
interface LiveCall {
  call: ToolCall;
  start: boolean;
  turnIndex?: number;
  callIndex?: number;
  textOffset?: unknown;
  runId?: string;
  taskId?: string;
}

interface FamilySpec<F extends Family> {
  /** Whether a stored row's tool name, its only discriminator, is this family's. */
  owns: (toolName: string) => boolean;
  project: (call: ToolCall) => FamilyFields<F>;
  /** Null when the envelope does not decode, which leaves the activity as it was. */
  live: (envelope: Envelope, previous: ActivityOf<F> | undefined) => LiveCall | null;
}

type Envelope = Readonly<Record<string, unknown>> & { name: string; phase?: unknown };

const decode = <S extends Parameters<typeof Schema.decodeUnknownOption>[0]>(
  schema: S,
  value: unknown,
): S["Type"] | null => Option.getOrNull(Schema.decodeUnknownOption(schema)(value));

const MEMORY_OUTCOMES = new Set<MemoryActivityOutcome>([
  "created",
  "updated",
  "unchanged",
  "rejected",
]);

export const toMemoryActivityReason = (value: unknown): MemoryActivityReason | undefined =>
  decode(MemoryActivityReason, value) ?? undefined;

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

export const readResearchProgress = (value: unknown): ResearchProgress | null =>
  decode(ResearchProgress, value);

/** A finished integration row, live or reloaded; both read the same projection. */
export const integrationActivityFromRow = (
  callId: string,
  activity: StoredIntegrationActivity,
): IntegrationToolActivity => ({
  family: "integration",
  callId,
  name: activity.name,
  ...integrationFields(activity),
});

const integrationFields = (activity: StoredIntegrationActivity) => ({
  status: activity.status === "complete" ? ("complete" as const) : ("error" as const),
  integrationId: activity.integrationId,
  tool: activity.tool,
  label: activity.label,
  access: activity.access,
  summary: activity.summary,
  ...(activity.status === "refused" ? { refused: true } : {}),
  ...(activity.error ? { error: activity.error } : {}),
  ...(activity.link ? { link: activity.link } : {}),
  ...(activity.sources?.length ? { sources: activity.sources } : {}),
  ...(activity.decidedIn ? { decidedIn: activity.decidedIn } : {}),
});

const errorOf = (call: ToolCall) => (call.error ? { error: call.error } : {});

/** A start or result envelope already decoded by its family's schema. */
const fromEnvelope = (
  parsed: { phase: string; turnIndex?: number; callIndex?: number; textOffset?: number },
  call: ToolCall,
  lineage: { runId?: string; taskId?: string } = {},
): LiveCall => ({
  call,
  start: parsed.phase === "start",
  ...(parsed.phase === "start"
    ? { turnIndex: parsed.turnIndex, callIndex: parsed.callIndex, textOffset: parsed.textOffset }
    : {}),
  ...(lineage.runId ? { runId: lineage.runId } : {}),
  ...(lineage.taskId ? { taskId: lineage.taskId } : {}),
});

/** A start envelope for a family whose running row keeps nothing. */
const started = (envelope: Envelope): LiveCall => ({
  call: { name: envelope.name, status: "running", result: null },
  start: true,
  ...(typeof envelope.turnIndex === "number" ? { turnIndex: envelope.turnIndex } : {}),
  ...(typeof envelope.callIndex === "number" ? { callIndex: envelope.callIndex } : {}),
  textOffset: envelope.textOffset,
});

/**
 * Drafts, documents and project files: a bounded outcome kept as the result,
 * and the handler's reason for one that did not land kept as the row's error.
 */
const outcomeFamily = <R>(
  owns: (toolName: string) => boolean,
  envelope: Parameters<typeof Schema.decodeUnknownOption>[0],
  project: (value: unknown) => R,
  ok: (result: R) => boolean,
) => ({
  owns,
  project: (call: ToolCall) => {
    if (call.status === "running") return { status: "running" as const };
    const result = project(call.result);
    return {
      status: ok(result) ? ("complete" as const) : ("error" as const),
      result,
      ...errorOf(call),
    };
  },
  live: (value: Envelope): LiveCall | null => {
    const parsed = decode(envelope, value) as
      | { phase: "start"; name: string; turnIndex: number; callIndex: number; textOffset?: number }
      | { phase: "result"; name: string; reason?: string }
      | null;
    if (!parsed) return null;
    if (parsed.phase === "start")
      return fromEnvelope(parsed, { name: parsed.name, status: "running", result: null });
    const result = project(parsed);
    return fromEnvelope(parsed, {
      name: parsed.name,
      status: ok(result) ? "complete" : "error",
      result,
      error: parsed.reason,
    });
  },
});

/** Office calls keep their bounded summary, whose own outcome and message say how it went. */
const officeFamily = <S extends { outcome: string; message: string }>(
  family: OfficeFamily,
  summary: (raw: unknown, failed: boolean) => S,
  envelope: Parameters<typeof Schema.decodeUnknownOption>[0],
) => ({
  owns: (toolName: string) => officeFamilyOfTool(toolName) === family,
  project: (call: ToolCall) => {
    if (call.status === "running") return { status: "running" as const };
    const kept = summary(call.result, call.status === "error");
    const failed = kept.outcome === "error";
    return {
      status: failed ? ("error" as const) : ("complete" as const),
      ...kept,
      ...(failed ? { error: kept.message } : {}),
    };
  },
  live: (value: Envelope): LiveCall | null => {
    const parsed = decode(envelope, value) as
      | { phase: "start"; name: string; turnIndex: number; callIndex: number; textOffset: number }
      | ({ phase: "result"; name: string } & S)
      | null;
    if (!parsed) return null;
    if (parsed.phase === "start")
      return fromEnvelope(parsed, { name: parsed.name, status: "running", result: null });
    return fromEnvelope(parsed, {
      name: parsed.name,
      status: parsed.outcome === "error" ? "error" : "complete",
      result: parsed,
    });
  },
});

const SkillLabel = Schema.Struct({
  skillId: SkillActivity.fields.skillId,
  skillName: SkillActivity.fields.skillName,
  path: SkillActivity.fields.path,
});

/** The kept custom tool activity without the tags its envelope leaves out. */
const CustomFields = Schema.Struct({
  displayName: CustomToolActivity.fields.displayName,
  resultPreview: CustomToolActivity.fields.resultPreview,
  resultChars: CustomToolActivity.fields.resultChars,
  error: CustomToolActivity.fields.error,
  fileIds: CustomToolActivity.fields.fileIds,
  workingFiles: CustomToolActivity.fields.workingFiles,
});

/** What an integration call is named as before its row has a result. */
const IntegrationStart = Schema.Struct({
  integrationId: StoredIntegrationActivity.fields.integrationId,
  tool: StoredIntegrationActivity.fields.tool,
  label: StoredIntegrationActivity.fields.label,
  access: StoredIntegrationActivity.fields.access,
  summary: StoredIntegrationActivity.fields.summary,
});

const KnowledgeTargets = Schema.Struct({ targets: Schema.Array(Schema.String) });
const LoadedFamilies = Schema.Struct({ loaded: LoadToolsResult.fields.loaded });
const RouteSummary = Schema.Struct({ route: MapRouteSummary });

const WEB_TOOLS = new Set(["web_search", "read_url"]);

/** What a web row keeps: the summary and sources, never page bodies. */
interface WebResult {
  targets?: string[];
  resultCount?: number;
  pagesFetched?: number;
  pages?: ToolPageStatus[];
  sources?: ToolSource[];
}

const lineageOf = (envelope: Envelope) => ({
  ...(typeof envelope.runId === "string" ? { runId: envelope.runId } : {}),
  ...(typeof envelope.taskId === "string" ? { taskId: envelope.taskId } : {}),
});

export const TOOL_FAMILIES: { [F in Family]: FamilySpec<F> } = {
  "agent-draft": outcomeFamily(
    Schema.is(AgentDraftToolName),
    AgentDraftToolEnvelope,
    projectAgentDraftResult,
    agentDraftResultOk,
  ),
  "schedule-draft": outcomeFamily(
    Schema.is(ScheduleDraftToolName),
    ScheduleDraftToolEnvelope,
    projectScheduleDraftResult,
    scheduleDraftResultOk,
  ),
  document: outcomeFamily(
    Schema.is(DocumentToolName),
    DocumentToolEnvelope,
    projectDocumentResult,
    documentResultOk,
  ),
  "project-file": outcomeFamily(
    Schema.is(ProjectFileToolName),
    ProjectFileToolEnvelope,
    projectProjectFileResult,
    projectFileResultOk,
  ),
  presentation: officeFamily(
    "presentation",
    OFFICE_FAMILIES.presentation.summary,
    OFFICE_FAMILIES.presentation.envelope,
  ),
  spreadsheet: officeFamily(
    "spreadsheet",
    OFFICE_FAMILIES.spreadsheet.summary,
    OFFICE_FAMILIES.spreadsheet.envelope,
  ),
  word: officeFamily("word", OFFICE_FAMILIES.word.summary, OFFICE_FAMILIES.word.envelope),

  skill: {
    owns: Schema.is(SkillToolName),
    project: (call) => {
      // A running row keeps nothing, so a reload names it only once it settles.
      const label = decode(SkillLabel, call.result);
      const result = call.status === "running" ? null : decode(SkillActivity, call.result);
      return {
        skillId: label?.skillId ?? "",
        skillName: label?.skillName ?? "Skill",
        path: label?.path ?? "",
        status:
          call.status === "running"
            ? "running"
            : result?.status === "complete"
              ? "complete"
              : "error",
        ...(result?.error ? { error: result.error } : {}),
      };
    },
    live: (value) => {
      const parsed = decode(SkillToolEnvelope, value);
      if (!parsed) return null;
      return fromEnvelope(
        parsed,
        {
          name: parsed.name,
          status: parsed.phase === "start" ? "running" : parsed.status,
          result: parsed,
        },
        parsed,
      );
    },
  },

  knowledge: {
    owns: Schema.is(KnowledgeToolName),
    project: (call) => {
      if (call.status === "running") {
        // Only the stream knows the queries of a running search.
        const running = decode(KnowledgeTargets, call.result);
        return {
          status: "running",
          ...(running
            ? {
                summary: {
                  targets: running.targets,
                  documentsListed: 0,
                  passagesReturned: 0,
                  remainingOps: 0,
                  coverage: "",
                },
              }
            : {}),
        };
      }
      const result = decode(KnowledgeActivityResult, call.result);
      return {
        status: call.status === "complete" && !result?.ok ? "error" : call.status,
        ...(result ? { summary: result.summary, sources: [...result.sources] } : {}),
        ...(result ? (result.error ? { error: result.error } : {}) : errorOf(call)),
      };
    },
    live: (value) => {
      const parsed = decode(KnowledgeToolEnvelope, value);
      if (!parsed) return null;
      return fromEnvelope(
        parsed,
        parsed.phase === "start"
          ? {
              name: parsed.name,
              status: "running",
              result: parsed.targets ? { targets: parsed.targets } : null,
            }
          : { name: parsed.name, status: parsed.ok ? "complete" : "error", result: parsed },
        parsed,
      );
    },
  },

  "tool-file": {
    owns: (toolName) => toolName === "publish_file" || toolName === "create_file",
    project: (call) => {
      const result = call.status === "running" ? null : decode(ToolFileActivity, call.result);
      return {
        status: call.status,
        ...(result?.attachmentId ? { attachmentId: result.attachmentId } : {}),
        ...(result?.workingFileId ? { workingFileId: result.workingFileId } : {}),
        ...(result ? (result.error ? { error: result.error } : {}) : errorOf(call)),
      };
    },
    live: (value) => {
      const parsed = decode(ToolFileEnvelope, value);
      if (!parsed) return null;
      if (parsed.phase === "start")
        return fromEnvelope(parsed, { name: parsed.name, status: "running", result: null });
      return fromEnvelope(parsed, {
        name: parsed.name,
        status: parsed.ok ? "complete" : "error",
        result: parsed,
      });
    },
  },

  image: {
    owns: (toolName) => toolName === IMAGE_TOOL,
    project: (call) => {
      // Every row is written with a running snapshot, so the shape is always kept.
      const kept = decode(ImageToolActivity, call.result);
      return {
        status: call.status,
        model: kept?.model ?? "",
        editing: kept?.editing ?? false,
        ...(kept?.aspectRatio ? { aspectRatio: kept.aspectRatio } : {}),
        requested: kept?.requested ?? 1,
        ...(kept ? { attachmentIds: kept.attachmentIds } : {}),
        ...(kept?.quality ? { quality: kept.quality } : {}),
        ...(kept?.adjustments?.length ? { adjustments: kept.adjustments } : {}),
        ...(kept?.refusal ? { refusal: kept.refusal } : {}),
        ...(kept ? (kept.error ? { error: kept.error } : {}) : errorOf(call)),
      };
    },
    live: (value) => {
      const parsed = decode(ImageToolEnvelope, value);
      if (!parsed) return null;
      if (parsed.phase === "start")
        return fromEnvelope(parsed, {
          name: parsed.name,
          status: "running",
          result: runningImageActivity({
            model: parsed.model,
            editing: parsed.editing,
            aspectRatio: parsed.aspectRatio,
            requested: parsed.count,
          }),
        });
      return fromEnvelope(parsed, { name: parsed.name, status: parsed.status, result: parsed });
    },
  },

  custom: {
    owns: isCustomToolName,
    project: (call) => {
      const kept = decode(CustomFields, call.result);
      return {
        displayName: kept?.displayName ?? call.name,
        status: call.status,
        ...(kept?.resultPreview !== undefined ? { resultPreview: kept.resultPreview } : {}),
        ...(kept?.resultChars !== undefined ? { resultChars: kept.resultChars } : {}),
        ...(kept ? (kept.error ? { error: kept.error } : {}) : errorOf(call)),
        ...(kept?.fileIds?.length ? { fileIds: kept.fileIds } : {}),
        ...(kept?.workingFiles?.length ? { workingFiles: kept.workingFiles } : {}),
      };
    },
    live: (value) => {
      const parsed = decode(CustomToolEnvelope, value);
      if (!parsed) return null;
      return fromEnvelope(parsed, {
        name: parsed.name,
        status: parsed.phase === "start" ? "running" : parsed.status,
        result: parsed,
      });
    },
  },

  integration: {
    owns: (toolName) => parseIntegrationToolName(toolName) !== null,
    project: (call) => {
      const kept = decode(StoredIntegrationActivity, call.result);
      if (kept) return integrationFields(kept);
      const start = decode(IntegrationStart, call.result);
      if (start) return { status: call.status, ...start, ...errorOf(call) };
      // Which type the integration is lives on the server; a row reloaded
      // while running is named from its tool until the result brings the label.
      const parsedName = parseIntegrationToolName(call.name);
      const tool = parsedName?.tool ?? call.name;
      const words = tool.replaceAll("_", " ");
      return {
        status: call.status,
        integrationId: parsedName?.integrationId ?? "",
        tool,
        label: `${words.charAt(0).toUpperCase()}${words.slice(1)}`,
        access: "read",
        summary: null,
        ...errorOf(call),
      };
    },
    live: (value) => {
      const parsed = decode(IntegrationToolEnvelope, value);
      if (!parsed) return null;
      return fromEnvelope(
        parsed,
        parsed.phase === "start"
          ? { name: parsed.name, status: "running", result: parsed }
          : {
              name: parsed.name,
              status: parsed.activity.status === "complete" ? "complete" : "error",
              result: parsed.activity,
            },
      );
    },
  },

  desktop: {
    owns: Schema.is(DesktopToolName),
    project: (call) => {
      // The row holds the summary only, never the file contents or command
      // output that reached the model, so a reload shows no body for it.
      const result = call.status === "running" ? null : decode(DesktopToolResult, call.result);
      return {
        status: result ? (result.ok ? "complete" : "error") : call.status,
        ...(call.args && typeof call.args === "object"
          ? { args: call.args as Record<string, unknown> }
          : {}),
        ...(result ? { result } : {}),
      };
    },
    live: (value, previous) => {
      if (!Schema.is(DesktopToolName)(value.name)) return null;
      if (value.phase === "start") {
        const start = started(value);
        return { ...start, call: { ...start.call, args: value.args } };
      }
      if (value.phase !== "result") return null;
      const result = decode(DesktopToolResult, value.result);
      // A result that does not decode leaves the activity alone rather than
      // dropping it to a state the transcript cannot explain.
      if (!result) return null;
      return {
        call: {
          name: value.name,
          status: result.ok ? "complete" : "error",
          result,
          args: previous?.args,
        },
        start: false,
      };
    },
  },

  research: {
    owns: (toolName) => toolName === "deep_research",
    project: (call) => {
      const kept = (call.result ?? {}) as { progress?: unknown; sources?: ToolSource[] };
      const progress = readResearchProgress(kept.progress);
      return {
        // A running row has not received its first progress yet; forcing a
        // terminal status here would make the reducer reject every later update.
        status: call.status === "complete" && !progress ? "error" : call.status,
        ...(progress ? { progress, runId: progress.runId } : {}),
        ...(kept.sources ? { sources: kept.sources } : {}),
        ...errorOf(call),
      };
    },
    live: (value, previous) => {
      const progress = readResearchProgress(value.progress);
      if (
        !progress ||
        value.name !== "deep_research" ||
        // The row id and the run id are different things: the call is minted by
        // the stream observer, the run by the handler it released. Only the
        // envelope's own `runId` correlates with the progress it carries.
        (value.runId !== undefined && value.runId !== progress.runId) ||
        (value.phase !== "start" && value.phase !== "progress" && value.phase !== "result")
      )
        return null;
      const sources = Array.isArray(value.sources)
        ? (value.sources as ToolSource[])
        : previous?.sources;
      const result = { progress, ...(sources ? { sources } : {}) };
      if (value.phase !== "result")
        return {
          ...started(value),
          start: value.phase === "start",
          call: { name: value.name, status: "running", result },
        };
      // The row's verdict rides the result: a run can finish without evidence.
      if (typeof value.ok !== "boolean") return null;
      return {
        call: {
          name: value.name,
          status: value.ok ? "complete" : "error",
          result,
          error: typeof value.error === "string" ? value.error : undefined,
        },
        start: false,
      };
    },
  },

  ask: {
    owns: (toolName) => toolName === "ask_user",
    project: (call) => {
      // Only a validated, successful presentation can supply questions.
      const questions = readPresentedQuestions(call.result);
      const kept = decode(AskUserResult, call.result);
      return {
        status: call.status === "running" ? "running" : questions ? "complete" : "error",
        ...(questions ? { questions } : {}),
        ...(call.status === "running"
          ? {}
          : kept
            ? kept.outcome === "rejected"
              ? { error: kept.message }
              : {}
            : errorOf(call)),
      };
    },
    live: (value) => {
      if (value.name !== "ask_user") return null;
      if (value.phase === "start") return started(value);
      if (value.phase !== "result") return null;
      return {
        call: {
          name: value.name,
          status: readPresentedQuestions(value.result) ? "complete" : "error",
          result: value.result,
        },
        start: false,
      };
    },
  },

  map: {
    owns: (toolName) => toolName === MAP_ROUTE_TOOL,
    project: (call) => {
      // The row keeps the whole route; the stream sends only its summary.
      const kept = decode(MapRouteResult, call.result);
      const route = kept ? summarizeMapRoute(kept) : decode(RouteSummary, call.result)?.route;
      return {
        status: call.status === "running" ? "running" : route ? "complete" : "error",
        ...(route ? { route } : {}),
      };
    },
    live: (value) => {
      if (value.name !== MAP_ROUTE_TOOL) return null;
      if (value.phase === "start") return started(value);
      if (value.phase !== "result") return null;
      return {
        call: {
          name: value.name,
          status: value.ok === true ? "complete" : "error",
          result: value.ok === true ? value : null,
        },
        start: false,
      };
    },
  },

  notify: {
    owns: (toolName) => toolName === "notify_user",
    project: (call) => {
      const kept = decode(NotifyToolResult, call.result);
      const message = kept?.outcome === "queued" ? kept.message : undefined;
      return {
        status: call.status === "running" ? "running" : message ? "complete" : "error",
        ...(message ? { message } : {}),
      };
    },
    live: (value) => {
      if (value.name !== "notify_user") return null;
      if (value.phase === "start") return started(value);
      if (value.phase !== "result" || typeof value.ok !== "boolean") return null;
      const message = typeof value.message === "string" ? value.message : undefined;
      return {
        call: {
          name: value.name,
          status: value.ok && message ? "complete" : "error",
          result: value.ok && message ? { v: 1, outcome: "queued", message } : null,
        },
        start: false,
      };
    },
  },

  plan: {
    owns: (toolName) => toolName === "update_plan",
    project: (call) => {
      const kept = decode(PlanToolResult, call.result);
      const steps = kept?.outcome === "updated" ? kept.steps : null;
      return {
        status: call.status === "running" ? "running" : steps ? "complete" : "error",
        ...(steps ? { steps } : {}),
      };
    },
    live: (value) => {
      // A later call is its own activity, and its list is the whole checklist.
      if (value.name !== "update_plan") return null;
      if (value.phase === "start") return started(value);
      if (value.phase !== "result" || typeof value.ok !== "boolean") return null;
      const steps = value.ok ? decode(Schema.Array(PlanStep), value.steps) : null;
      return {
        call: {
          name: value.name,
          status: steps ? "complete" : "error",
          result: steps ? { v: 1, outcome: "updated", steps } : null,
        },
        start: false,
      };
    },
  },

  attachment: {
    owns: (toolName) => toolName === "read_attachment",
    project: (call) => {
      const read = call.status === "running" ? null : decode(AttachmentReadActivity, call.result);
      return {
        status: call.status === "running" ? "running" : read?.ok ? "complete" : "error",
        ...(read ? { read } : {}),
      };
    },
    live: (value) => {
      if (value.name !== "read_attachment") return null;
      if (value.phase === "start") return started(value);
      if (value.phase !== "result") return null;
      return {
        call: { name: value.name, status: value.ok === true ? "complete" : "error", result: value },
        start: false,
      };
    },
  },

  "tool-load": {
    owns: (toolName) => toolName === "load_tools",
    project: (call) => {
      const kept = call.status === "running" ? null : decode(LoadedFamilies, call.result);
      return {
        status: call.status === "running" ? "running" : kept ? "complete" : "error",
        ...(kept ? { loaded: kept.loaded } : {}),
      };
    },
    live: (value) => {
      if (value.name !== "load_tools") return null;
      if (value.phase === "start") return started(value);
      if (value.phase !== "result") return null;
      return {
        call: {
          name: value.name,
          status: value.ok === true ? "complete" : "error",
          result: value.ok === true ? value : null,
        },
        start: false,
      };
    },
  },

  memory: {
    owns: (toolName) => toolName === "save_memory",
    project: (call) => {
      // Summary only: memory content never reaches stream state or the row.
      const kept = (call.result ?? {}) as { outcome?: unknown; reason?: unknown; scope?: unknown };
      const outcome = toMemoryActivityOutcome(kept.outcome);
      const reason = toMemoryActivityReason(kept.reason);
      return {
        status: call.status,
        ...(outcome ? { outcome } : {}),
        ...(reason ? { reason } : {}),
        ...(kept.scope === "project" ? { scope: "project" as const } : {}),
        ...errorOf(call),
      };
    },
    live: (value) => {
      if (value.phase === "start") return started(value);
      if (value.phase !== "result" || typeof value.ok !== "boolean") return null;
      return {
        call: {
          name: value.name,
          status: value.ok ? "complete" : "error",
          result: value,
          error: typeof value.error === "string" ? value.error : undefined,
        },
        start: false,
      };
    },
  },

  web: {
    owns: (toolName) => WEB_TOOLS.has(toolName),
    project: (call) => {
      const args = (call.args ?? {}) as { queries?: string[]; urls?: string[] };
      const kept = (call.result ?? {}) as WebResult;
      return {
        targets: kept.targets ?? args.queries ?? args.urls ?? [],
        status: call.status,
        ...(kept.resultCount !== undefined ? { resultCount: kept.resultCount } : {}),
        ...(kept.pagesFetched !== undefined ? { pagesFetched: kept.pagesFetched } : {}),
        ...(kept.pages !== undefined ? { pages: kept.pages } : {}),
        ...(kept.sources !== undefined ? { sources: kept.sources } : {}),
        ...errorOf(call),
      };
    },
    live: (value, previous) => {
      const summary = (value.summary ?? {}) as WebResult;
      const pages = value.pages === undefined ? {} : { pages: value.pages as ToolPageStatus[] };
      if (value.phase === "start") {
        const args = (value.args ?? {}) as { targets?: string[] };
        return {
          ...started(value),
          call: { name: value.name, status: "running", result: { targets: args.targets ?? [] } },
          ...lineageOf(value),
        };
      }
      if (value.phase === "progress")
        return {
          call: {
            name: value.name,
            status: "running",
            result: {
              targets: summary.targets ?? previous?.targets ?? [],
              ...(summary.resultCount !== undefined ? { resultCount: summary.resultCount } : {}),
              ...pages,
            },
          },
          start: false,
          ...lineageOf(value),
        };
      if (value.phase !== "result" || typeof value.ok !== "boolean") return null;
      return {
        call: {
          name: value.name,
          status: value.ok ? "complete" : "error",
          result: {
            targets: summary.targets ?? [],
            ...(summary.resultCount !== undefined ? { resultCount: summary.resultCount } : {}),
            ...(summary.pagesFetched !== undefined ? { pagesFetched: summary.pagesFetched } : {}),
            ...pages,
            ...(value.sources !== undefined ? { sources: value.sources as ToolSource[] } : {}),
          },
          error: typeof value.error === "string" ? value.error : undefined,
        },
        start: false,
        ...lineageOf(value),
      };
    },
  },
};

const FAMILIES = Object.keys(TOOL_FAMILIES) as Family[];

export const isToolFamily = (value: unknown): value is Family =>
  typeof value === "string" && Object.hasOwn(TOOL_FAMILIES, value);

/** A stored row's family, by its tool name; an unknown name is an old web row. */
export const familyOfTool = (toolName: string): Family =>
  FAMILIES.find((family) => TOOL_FAMILIES[family].owns(toolName)) ?? "web";

/** A live envelope as its family reads it; `previous` is that family's activity for the call. */
export const readLiveCall = (
  family: Family,
  envelope: Envelope,
  previous: ToolActivity | undefined,
): LiveCall | null =>
  // The caller matched `previous` to the family; the compiler cannot correlate them.
  (TOOL_FAMILIES[family].live as FamilySpec<Family>["live"])(envelope, previous);

/** Builds the activity from a call and where it sits. */
export const projectToolCall = (
  family: Family,
  call: ToolCall,
  placement: {
    callId: string;
    turnIndex: number;
    callIndex: number;
    textOffset?: number | undefined;
    runId?: string | undefined;
    taskId?: string | undefined;
  },
): ToolActivity =>
  ({
    family,
    ...(placement.textOffset === undefined ? {} : { textOffset: placement.textOffset }),
    ...(placement.runId ? { runId: placement.runId } : {}),
    ...(placement.taskId ? { taskId: placement.taskId } : {}),
    callId: placement.callId,
    name: call.name,
    turnIndex: placement.turnIndex,
    callIndex: placement.callIndex,
    ...TOOL_FAMILIES[family].project(call),
    // The family and its fields match; the compiler cannot correlate them.
  }) as ToolActivity;
