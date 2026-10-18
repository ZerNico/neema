import { useCallback, useState } from "react";
import { useMessageStream } from "../client/use-message-stream.ts";
import type { ConversationData } from "./conversation-window.ts";
import { streamSeed } from "./stream-seed.ts";

/** The person's own message an answer replies to: the nearest one before it that is not a steer. */
const questionBefore = (
  messages: ReadonlyArray<{ id: string; role: string; steeredIntoMessageId?: string | null }>,
  answerId: string,
) => {
  const answer = messages.findIndex((message) => message.id === answerId);
  for (let index = answer - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user" && !message.steeredIntoMessageId) return message.id;
  }
  return null;
};

/**
 * The answer being written and the stream that shows it, plus the question a
 * turn this tab started holds at the top of the view while it arrives.
 */
export function useLiveAnswer({
  data,
  conversationId,
  anchorFirstTurn,
}: {
  data: ConversationData;
  conversationId: string;
  anchorFirstTurn: boolean;
}) {
  const streamingMessage = data.messages.find((m) => m.status === "streaming");
  // A turn this tab started is read from its question: once its answer starts
  // streaming, that question is held at the top of the view. Decided while
  // rendering, so the new rows never commit with the list still following.
  // (Guarded render-time adjust.)
  const [anchorRequested, setAnchorRequested] = useState(
    // A first answer that already finished has nothing left to arrive.
    () => anchorFirstTurn && streamingMessage !== undefined,
  );
  const [anchorId, setAnchorId] = useState<string | null>(null);
  if (anchorRequested && streamingMessage) {
    setAnchorRequested(false);
    setAnchorId(questionBefore(data.messages, streamingMessage.id));
  }
  const releaseAnchor = useCallback(() => setAnchorId(null), []);
  // The row the stream overlay applies to. Sticky beyond streamingMessage:
  // when the generation finishes, the sync bus refetches and the row flips to
  // complete before the smoothed text drains. Dropping the overlay at that
  // moment would pop the tail in, exactly what smoothing exists to prevent.
  // (Guarded render-time adjust.)
  const [overlayId, setOverlayId] = useState<string | null>(null);
  if (streamingMessage && streamingMessage.id !== overlayId) {
    setOverlayId(streamingMessage.id);
  }
  // The stream starts from the chunks there were when its generation began, a snapshot
  // taken once: chunks arriving later reach it live, not by seeding it again. Retry, edit
  // and resume each start a new generation, so the key alone tells them apart.
  const streamKey = streamingMessage
    ? `${streamingMessage.id}\n${streamingMessage.generationId ?? ""}`
    : null;
  const [seeded, setSeeded] = useState<{
    key: string;
    seed: ReturnType<typeof streamSeed>;
  } | null>(null);
  // The stream reads its seed in this same pass, resetting to it when the key changes, so a
  // seed only stored for the next pass would be read as none: an answer reloaded mid-stream
  // or resumed would lose every earlier chunk the subscription then skips.
  const freshSeed =
    streamingMessage && streamKey !== null && seeded?.key !== streamKey
      ? streamSeed(streamingMessage, data)
      : null;
  if (streamKey !== (seeded?.key ?? null))
    setSeeded(freshSeed && streamKey ? { key: streamKey, seed: freshSeed } : null);
  const initialStream =
    streamKey === null ? null : seeded?.key === streamKey ? seeded.seed : freshSeed;

  // A sync refresh can see the terminal row before SSE has delivered its last
  // chunks and done marker. Keep that subscription alive so the sticky overlay
  // can drain instead of getting stranded with stale tools and streaming status.
  const subscribedMessage =
    streamingMessage ?? data.messages.find((message) => message.id === overlayId);
  const stream = useMessageStream(
    subscribedMessage?.id ?? null,
    initialStream,
    conversationId,
    subscribedMessage?.generationId ?? null,
    subscribedMessage?.status,
  );
  const liveId = streamingMessage?.id ?? (stream.status === "streaming" ? overlayId : null);
  return {
    streamingMessage,
    stream,
    /** The row the stream overlay is drawn on, while there is one. */
    liveId,
    anchorId,
    releaseAnchor,
    /** Anchors the next answer that starts streaming at the question before it. */
    requestAnchor: () => setAnchorRequested(true),
    cancelAnchor: () => setAnchorRequested(false),
  };
}
