import type { LiveTextSnapshot } from "../client/live-text.ts";
import type { DisplayMessage, LiveStream } from "./message-list.tsx";

/** Marks a card placed at the end of its answer rather than by a tool row of its own. */
export const PLACED_CALL_PREFIX = "placed:";

/** The live answer as drawn at one pacing tick. */
export function withLiveText(
  message: DisplayMessage,
  status: LiveStream["status"],
  snapshot: LiveTextSnapshot,
): DisplayMessage {
  // Status comes from the stream, not the row: the refetched row says
  // complete while the last words are still landing.
  const following = status === "streaming";
  const ahead = snapshot.text.length > message.content.length;
  const content = following || ahead ? snapshot.text : message.content;
  return {
    ...message,
    content,
    status: following ? "streaming" : ahead ? status : message.status,
    reasoning: snapshot.reasoning,
    reasoningSeen: snapshot.reasoningSeen || message.reasoningSeen,
    rawTextLength: snapshot.rawTextLength,
    // A placed card belongs at the end of the answer, which moves while it streams.
    toolActivities: message.toolActivities.some((a) => a.callId.startsWith(PLACED_CALL_PREFIX))
      ? message.toolActivities.map((a) =>
          a.callId.startsWith(PLACED_CALL_PREFIX) ? { ...a, textOffset: content.length } : a,
        )
      : message.toolActivities,
  };
}
