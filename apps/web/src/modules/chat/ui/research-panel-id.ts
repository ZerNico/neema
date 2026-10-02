import type { ResearchToolActivity, ToolActivity } from "../client/use-message-stream.ts";

/**
 * A research call's place among its message's research calls, in call order.
 * The panel is keyed by it rather than by the run, so it can open while the
 * model is still writing the brief and keep following the run that replaces
 * that placeholder at the same place.
 */
export const researchPosition = (activities: ReadonlyArray<ToolActivity>, callId: string) =>
  activities
    .filter((activity): activity is ResearchToolActivity => activity.family === "research")
    .toSorted(
      (a, b) => (a.turnIndex ?? 0) - (b.turnIndex ?? 0) || (a.callIndex ?? 0) - (b.callIndex ?? 0),
    )
    .findIndex((activity) => activity.callId === callId);

export const researchPanelId = (messageId: string, position: number) =>
  `research:${JSON.stringify([messageId, position])}`;
