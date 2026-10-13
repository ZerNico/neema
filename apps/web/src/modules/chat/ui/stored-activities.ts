import { OFFICE_FAMILIES, officeFamilyOfTool } from "~/modules/office/families.ts";
import { ToolFileActivity } from "../tool-file-schema.ts";
import { IMAGE_TOOL, ImageToolActivity } from "~/modules/images/tool-schema.ts";
import { parseIntegrationToolName } from "~/modules/integrations/manifest.ts";
import { IntegrationToolActivity as StoredIntegrationActivity } from "~/modules/integrations/tool-schema.ts";
import {
  DocumentToolName,
  documentResultOk,
  projectDocumentResult,
} from "~/modules/documents/tool-schema.ts";
import {
  ProjectFileToolName,
  projectFileResultOk,
  projectProjectFileResult,
} from "~/modules/projects/file-tool-schema.ts";
import {
  AgentDraftToolName,
  projectAgentDraftResult,
  agentDraftResultOk,
} from "~/modules/agents/tool-schema.ts";
import {
  ScheduleDraftToolName,
  projectScheduleDraftResult,
  scheduleDraftResultOk,
} from "~/modules/schedules/tool-schema.ts";
import { SkillActivity, SkillToolName } from "~/modules/skills/tool-schema.ts";
import { CustomToolActivity } from "~/modules/custom-tools/tool-schema.ts";
import { isCustomToolName } from "~/modules/custom-tools/schema.ts";
import { KnowledgeActivityResult, KnowledgeToolName } from "~/modules/knowledge/tool-schema.ts";
import { Option, Schema } from "effect";
import {
  integrationActivityFromRow,
  toMemoryActivityOutcome,
  toMemoryActivityReason,
  readTextOffset,
  readResearchProgress,
  type CompactionActivity,
  type OfficeActivity,
  type ToolActivity,
  type ToolPageStatus,
  type ToolSource,
} from "../client/use-message-stream.ts";
import { DesktopToolName, DesktopToolResult } from "~/modules/desktop/tool-schema.ts";
import { readPresentedQuestions } from "~/modules/tools/ask-user-schema.ts";
import { PlanToolResult } from "~/modules/tools/plan-schema.ts";
import { NotifyToolResult } from "~/modules/schedules/notify-schema.ts";
import {
  MAP_ROUTE_TOOL,
  MapRouteResult,
  summarizeMapRoute,
} from "~/modules/genui/map-tool-schema.ts";
import { LoadToolsResult } from "~/modules/tools/tool-load-schema.ts";
import { AttachmentReadActivity } from "../attachment-tool-schema.ts";

export const epoch = (value: Date | string | null | undefined) =>
  value ? new Date(value).getTime() || undefined : undefined;

/**
 * A row's activity with the times it records, so a reloaded answer, still
 * streaming or settled, says how long it worked rather than restarting its clock.
 */
export const timedActivity = (
  row: Parameters<typeof toActivity>[0] & {
    startedAt?: Date | string | null;
    completedAt?: Date | string | null;
  },
): ToolActivity => {
  const startedAt = epoch(row.startedAt);
  const completedAt = epoch(row.completedAt);
  return {
    ...toActivity(row),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
  } as ToolActivity;
};

/**
 * Durable message_tool_calls row → the same family-discriminated shape used by
 * live chunks. The tool name is the durable discriminator; old web rows never
 * carried a family field of their own.
 */
export function toActivity(row: {
  id: string;
  toolName: string;
  arguments: unknown;
  result: unknown;
  status: "running" | "complete" | "error";
  turnIndex: number;
  callIndex: number;
  textOffset?: number | null;
  researchRunId?: string | null;
  researchTaskId?: string | null;
  error: { code: string; message: string } | null;
}): ToolActivity {
  const textOffset = readTextOffset(row.textOffset);
  const position = textOffset === undefined ? {} : { textOffset };
  if (Schema.is(AgentDraftToolName)(row.toolName)) {
    const result = projectAgentDraftResult(row.result);
    return {
      family: "agent-draft",
      ...position,
      callId: row.id,
      name: row.toolName,
      turnIndex: row.turnIndex,
      callIndex: row.callIndex,
      status:
        row.status === "running" ? "running" : agentDraftResultOk(result) ? "complete" : "error",
      ...(row.status === "running" ? {} : { result }),
      ...(row.error ? { error: row.error.message } : {}),
    };
  }
  if (Schema.is(ScheduleDraftToolName)(row.toolName)) {
    const result = projectScheduleDraftResult(row.result);
    return {
      family: "schedule-draft",
      ...position,
      callId: row.id,
      name: row.toolName,
      turnIndex: row.turnIndex,
      callIndex: row.callIndex,
      status:
        row.status === "running" ? "running" : scheduleDraftResultOk(result) ? "complete" : "error",
      ...(row.status === "running" ? {} : { result }),
      ...(row.error ? { error: row.error.message } : {}),
    };
  }
  if (Schema.is(DocumentToolName)(row.toolName)) {
    const result = projectDocumentResult(row.result);
    return {
      family: "document",
      ...position,
      callId: row.id,
      name: row.toolName,
      turnIndex: row.turnIndex,
      callIndex: row.callIndex,
      status:
        row.status === "running" ? "running" : documentResultOk(result) ? "complete" : "error",
      ...(row.status === "running" ? {} : { result }),
      ...(row.error ? { error: row.error.message } : {}),
    };
  }
  if (Schema.is(ProjectFileToolName)(row.toolName)) {
    const result = projectProjectFileResult(row.result);
    return {
      family: "project-file",
      ...position,
      callId: row.id,
      name: row.toolName,
      turnIndex: row.turnIndex,
      callIndex: row.callIndex,
      status:
        row.status === "running" ? "running" : projectFileResultOk(result) ? "complete" : "error",
      ...(row.status === "running" ? {} : { result }),
      ...(row.error ? { error: row.error.message } : {}),
    };
  }
  if (Schema.is(SkillToolName)(row.toolName)) {
    const result = Option.getOrNull(Schema.decodeUnknownOption(SkillActivity)(row.result));
    return {
      family: "skill",
      ...position,
      callId: row.id,
      name: row.toolName,
      turnIndex: row.turnIndex,
      callIndex: row.callIndex,
      skillId: result?.skillId ?? "",
      skillName: result?.skillName ?? "Skill",
      path: result?.path ?? "",
      status:
        row.status === "running" ? "running" : result?.status === "complete" ? "complete" : "error",
      ...(row.researchRunId ? { runId: row.researchRunId } : {}),
      ...(row.researchTaskId ? { taskId: row.researchTaskId } : {}),
    };
  }
  if (row.toolName === MAP_ROUTE_TOOL) {
    const result = Option.getOrNull(Schema.decodeUnknownOption(MapRouteResult)(row.result));
    const route = result ? summarizeMapRoute(result) : null;
    return {
      family: "map",
      ...position,
      callId: row.id,
      name: row.toolName,
      turnIndex: row.turnIndex,
      callIndex: row.callIndex,
      status: row.status === "running" ? "running" : route ? "complete" : "error",
      ...(route ? { route } : {}),
    };
  }
  if (row.toolName === "notify_user") {
    const result = Option.getOrNull(Schema.decodeUnknownOption(NotifyToolResult)(row.result));
    const message = result?.outcome === "queued" ? result.message : undefined;
    return {
      family: "notify",
      ...position,
      callId: row.id,
      name: row.toolName,
      turnIndex: row.turnIndex,
      callIndex: row.callIndex,
      status: row.status === "running" ? "running" : message ? "complete" : "error",
      ...(message ? { message } : {}),
    };
  }
  if (row.toolName === "update_plan") {
    const result = Option.getOrNull(Schema.decodeUnknownOption(PlanToolResult)(row.result));
    const steps = result?.outcome === "updated" ? result.steps : null;
    return {
      family: "plan",
      ...position,
      callId: row.id,
      name: row.toolName,
      turnIndex: row.turnIndex,
      callIndex: row.callIndex,
      status: row.status === "running" ? "running" : steps ? "complete" : "error",
      ...(steps ? { steps } : {}),
    };
  }
  if (row.toolName === "read_attachment") {
    const read = Option.getOrNull(Schema.decodeUnknownOption(AttachmentReadActivity)(row.result));
    return {
      family: "attachment",
      ...position,
      callId: row.id,
      name: row.toolName,
      turnIndex: row.turnIndex,
      callIndex: row.callIndex,
      status: row.status === "running" ? "running" : read?.ok ? "complete" : "error",
      ...(read ? { read } : {}),
    };
  }
  if (row.toolName === "load_tools") {
    const result = Option.getOrNull(Schema.decodeUnknownOption(LoadToolsResult)(row.result));
    return {
      family: "tool-load",
      ...position,
      callId: row.id,
      name: row.toolName,
      turnIndex: row.turnIndex,
      callIndex: row.callIndex,
      status: row.status === "running" ? "running" : result ? "complete" : "error",
      ...(result ? { loaded: result.loaded } : {}),
    };
  }
  if (Schema.is(KnowledgeToolName)(row.toolName)) {
    const result = Option.getOrNull(
      Schema.decodeUnknownOption(KnowledgeActivityResult)(row.result),
    );
    return {
      family: "knowledge",
      ...position,
      callId: row.id,
      name: row.toolName,
      ...(row.researchRunId ? { runId: row.researchRunId } : {}),
      ...(row.researchTaskId ? { taskId: row.researchTaskId } : {}),
      turnIndex: row.turnIndex,
      callIndex: row.callIndex,
      status: row.status === "complete" && (!result || !result.ok) ? "error" : row.status,
      ...(result ? { summary: result.summary, sources: [...result.sources] } : {}),
      ...(row.error ? { error: row.error.message } : result?.error ? { error: result.error } : {}),
    };
  }
  if (row.toolName === "deep_research") {
    const result = (row.result ?? {}) as { progress?: unknown; sources?: ToolSource[] };
    const progress = readResearchProgress(result.progress);
    return {
      family: "research",
      ...position,
      callId: row.id,
      name: row.toolName,
      turnIndex: row.turnIndex,
      callIndex: row.callIndex,
      // A running row has not received its first progress yet; forcing a
      // terminal status here would make the reducer reject every later update.
      status: row.status === "complete" && !progress ? "error" : row.status,
      ...(progress ? { progress, runId: progress.runId } : {}),
      ...(result.sources ? { sources: result.sources } : {}),
      ...(row.error ? { error: row.error.message } : {}),
    };
  }
  if (row.toolName === "ask_user") {
    const questions = readPresentedQuestions(row.result);
    return {
      family: "ask",
      ...position,
      callId: row.id,
      name: row.toolName,
      turnIndex: row.turnIndex,
      callIndex: row.callIndex,
      status: row.status === "complete" && !questions ? "error" : row.status,
      ...(questions ? { questions } : {}),
      ...(row.error ? { error: row.error.message } : {}),
    };
  }
  if (row.toolName === "save_memory") {
    const result = (row.result ?? {}) as { outcome?: unknown; reason?: unknown; scope?: unknown };
    const outcome = toMemoryActivityOutcome(result.outcome);
    const reason = toMemoryActivityReason(result.reason);
    const scope = result.scope === "project" ? ({ scope: "project" } as const) : {};
    return {
      family: "memory",
      ...position,
      callId: row.id,
      name: row.toolName,
      turnIndex: row.turnIndex,
      callIndex: row.callIndex,
      status: row.status,
      ...(outcome ? { outcome } : {}),
      ...(reason ? { reason } : {}),
      ...scope,
      ...(row.error ? { error: row.error.message } : {}),
    };
  }

  const integrationCall = parseIntegrationToolName(row.toolName);
  if (integrationCall) {
    // Also ahead of the web fallback. A finished row carries its own
    // projection; a running one (reload mid-answer) is named from the manifest.
    const stored = Option.getOrNull(
      Schema.decodeUnknownOption(StoredIntegrationActivity)(row.result),
    );
    if (stored)
      return {
        ...integrationActivityFromRow(row.id, stored),
        ...position,
        turnIndex: row.turnIndex,
        callIndex: row.callIndex,
      };
    // Which type the integration is lives on the server; a row still running
    // on reload is named from its tool until the result brings the label.
    const words = integrationCall.tool.replaceAll("_", " ");
    return {
      family: "integration",
      ...position,
      callId: row.id,
      name: row.toolName,
      turnIndex: row.turnIndex,
      callIndex: row.callIndex,
      status: row.status,
      integrationId: integrationCall.integrationId,
      tool: integrationCall.tool,
      label: `${words.charAt(0).toUpperCase()}${words.slice(1)}`,
      access: "read",
      summary: null,
      ...(row.error ? { error: row.error.message } : {}),
    };
  }

  const office = officeFamilyOfTool(row.toolName);
  if (office) {
    return {
      family: office,
      ...position,
      callId: row.id,
      name: row.toolName,
      turnIndex: row.turnIndex,
      callIndex: row.callIndex,
      status: row.status,
      ...OFFICE_FAMILIES[office].summary(row.result, row.status === "error"),
      ...(row.error ? { error: row.error.message } : {}),
      // The family and its summary match; the compiler cannot correlate them.
    } as OfficeActivity;
  }
  if (row.toolName === "publish_file" || row.toolName === "create_file") {
    const result = Option.getOrNull(Schema.decodeUnknownOption(ToolFileActivity)(row.result));
    return {
      family: "tool-file",
      ...position,
      callId: row.id,
      name: row.toolName,
      turnIndex: row.turnIndex,
      callIndex: row.callIndex,
      status: row.status,
      ...(result?.attachmentId ? { attachmentId: result.attachmentId } : {}),
      ...(result?.workingFileId ? { workingFileId: result.workingFileId } : {}),
      ...(row.error ? { error: row.error.message } : result?.error ? { error: result.error } : {}),
    };
  }

  if (row.toolName === IMAGE_TOOL) {
    // Every row is written with a running snapshot, so the shape is always stored.
    const stored = Option.getOrNull(Schema.decodeUnknownOption(ImageToolActivity)(row.result));
    return {
      family: "image",
      ...position,
      callId: row.id,
      name: row.toolName,
      turnIndex: row.turnIndex,
      callIndex: row.callIndex,
      status: row.status,
      model: stored?.model ?? "",
      editing: stored?.editing ?? false,
      ...(stored?.aspectRatio ? { aspectRatio: stored.aspectRatio } : {}),
      requested: stored?.requested ?? 1,
      ...(stored ? { attachmentIds: stored.attachmentIds } : {}),
      ...(stored?.quality ? { quality: stored.quality } : {}),
      ...(stored?.adjustments?.length ? { adjustments: stored.adjustments } : {}),
      ...(stored?.refusal ? { refusal: stored.refusal } : {}),
      ...(row.error && !stored?.refusal
        ? { error: row.error.message }
        : stored?.error
          ? { error: stored.error }
          : {}),
    };
  }

  if (isCustomToolName(row.toolName)) {
    // Must precede the web fallback below: a `custom_…` row holds a
    // CustomToolActivity, not web targets.
    const stored = Option.getOrNull(Schema.decodeUnknownOption(CustomToolActivity)(row.result));
    return {
      family: "custom",
      ...position,
      callId: row.id,
      name: row.toolName,
      displayName: stored?.displayName ?? row.toolName,
      turnIndex: row.turnIndex,
      callIndex: row.callIndex,
      status: row.status,
      ...(stored?.resultPreview !== undefined ? { resultPreview: stored.resultPreview } : {}),
      ...(stored?.resultChars !== undefined ? { resultChars: stored.resultChars } : {}),
      ...(row.error ? { error: row.error.message } : stored?.error ? { error: stored.error } : {}),
      ...(stored?.fileIds?.length ? { fileIds: stored.fileIds } : {}),
      ...(stored?.workingFiles?.length ? { workingFiles: stored.workingFiles } : {}),
    };
  }

  if (Schema.is(DesktopToolName)(row.toolName)) {
    // The persisted row holds the summary only, never the file contents or
    // command output that the live envelope carried, so a reload shows the
    // row without its disclosure rather than inventing a body for it.
    const stored = Option.getOrNull(Schema.decodeUnknownOption(DesktopToolResult)(row.result));
    return {
      family: "desktop",
      ...position,
      callId: row.id,
      name: row.toolName,
      turnIndex: row.turnIndex,
      callIndex: row.callIndex,
      status: row.status,
      ...(row.arguments && typeof row.arguments === "object"
        ? { args: row.arguments as Record<string, unknown> }
        : {}),
      ...(stored ? { result: stored } : {}),
    };
  }

  const args = (row.arguments ?? {}) as { queries?: string[]; urls?: string[] };
  const result = (row.result ?? {}) as {
    targets?: string[];
    resultCount?: number;
    pagesFetched?: number;
    pages?: ToolPageStatus[];
    sources?: ToolSource[];
  };
  return {
    family: "web",
    ...position,
    ...(row.researchRunId ? { runId: row.researchRunId } : {}),
    ...(row.researchTaskId ? { taskId: row.researchTaskId } : {}),
    callId: row.id,
    name: row.toolName,
    turnIndex: row.turnIndex,
    callIndex: row.callIndex,
    targets: result.targets ?? args.queries ?? args.urls ?? [],
    status: row.status,
    ...(result.resultCount !== undefined ? { resultCount: result.resultCount } : {}),
    ...(result.pagesFetched !== undefined ? { pagesFetched: result.pagesFetched } : {}),
    ...(result.pages !== undefined ? { pages: result.pages } : {}),
    ...(result.sources !== undefined ? { sources: result.sources } : {}),
    ...(row.error ? { error: row.error.message } : {}),
  };
}

export function toCompactionActivity(row: {
  id: string;
  beforeTurnIndex: number;
  passIndex: number;
  scope: "history" | "active_rounds";
  status: "running" | "complete" | "error";
  outcome: "summary" | "hard_truncation" | null;
  summary: string | null;
  textOffset?: number | null;
  researchRunId?: string | null;
  researchTaskId?: string | null;
}): CompactionActivity {
  const textOffset = readTextOffset(row.textOffset);
  return {
    eventId: row.id,
    ...(row.researchRunId ? { runId: row.researchRunId } : {}),
    ...(row.researchTaskId ? { taskId: row.researchTaskId } : {}),
    ...(textOffset === undefined ? {} : { textOffset }),
    beforeTurnIndex: row.beforeTurnIndex,
    passIndex: row.passIndex,
    scope: row.scope,
    status: row.status === "error" ? "failed" : row.status,
    ...(row.outcome ? { outcome: row.outcome } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
  };
}
