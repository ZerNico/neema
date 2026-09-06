import type {
  CompactionActivity,
  ToolActivity,
  WebToolActivity,
} from "../client/use-message-stream.ts";

type PositionedActivity =
  | { kind: "tool"; activity: ToolActivity }
  | { kind: "compaction"; activity: CompactionActivity };

export type AssistantBodyPart =
  | { kind: "text"; key: string; content: string; streaming: boolean }
  | { kind: "web"; key: string; activities: WebToolActivity[] }
  | { kind: "tool"; key: string; activity: Exclude<ToolActivity, WebToolActivity> }
  | { kind: "compaction"; key: string; activity: CompactionActivity };

const turnOf = (item: PositionedActivity) =>
  item.kind === "tool" ? (item.activity.turnIndex ?? 0) : item.activity.beforeTurnIndex;
const orderOf = (item: PositionedActivity) =>
  item.kind === "tool" ? (item.activity.callIndex ?? 0) : item.activity.passIndex;

/** Original UTF-16 offsets, never rendered markdown lengths or clamped anchors. */
export function projectAssistantBody({
  content,
  rawTextLength = content.length,
  streaming,
  tools,
  compactions,
}: {
  content: string;
  rawTextLength?: number;
  streaming: boolean;
  tools: ToolActivity[];
  compactions: CompactionActivity[];
}): { chronological: boolean; parts: AssistantBodyPart[] } {
  const researchRuns = new Set(
    tools.flatMap((activity) =>
      activity.family === "research" && activity.progress ? [activity.progress.runId] : [],
    ),
  );
  const activities: PositionedActivity[] = [
    ...tools
      .filter(
        (activity) =>
          !(activity.family === "web" && activity.runId && researchRuns.has(activity.runId)),
      )
      .map((activity): PositionedActivity => ({ kind: "tool", activity })),
    ...compactions
      .filter((activity) => !(activity.runId && researchRuns.has(activity.runId)))
      .map((activity): PositionedActivity => ({ kind: "compaction", activity })),
  ];
  // Logical ordering is authoritative for equal offsets and legacy messages.
  // oxlint-disable-next-line no-array-sort -- fresh array
  activities.sort(
    (a, b) =>
      turnOf(a) - turnOf(b) ||
      (a.kind === b.kind ? orderOf(a) - orderOf(b) : a.kind === "compaction" ? -1 : 1),
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
    if (item.kind === "compaction") {
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
