import type { ToolFamily } from "~/modules/tools/families.ts";
import { projectToolCall, readTextOffset } from "../client/tool-families.ts";
import type { CompactionActivity, ToolActivity } from "../client/use-message-stream.ts";

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
 * live chunks, through the same projection. The row's stored family, written
 * by the group that offered the call, is the discriminator.
 */
export function toActivity(row: {
  id: string;
  toolName: string;
  family: ToolFamily;
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
  return projectToolCall(
    row.family,
    {
      name: row.toolName,
      status: row.status,
      result: row.result,
      args: row.arguments,
      error: row.error?.message,
    },
    {
      callId: row.id,
      turnIndex: row.turnIndex,
      callIndex: row.callIndex,
      textOffset: readTextOffset(row.textOffset),
      runId: row.researchRunId ?? undefined,
      taskId: row.researchTaskId ?? undefined,
    },
  );
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
