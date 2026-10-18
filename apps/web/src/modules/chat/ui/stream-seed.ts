import { lookupsOf, type AssistantFile } from "../assistant-output.ts";
import {
  applyCompactionChunk,
  applyFileChunk,
  applySteerChunk,
  applyToolActivityChunk,
  isStaleWriting,
  type CompactionActivity,
  type ToolActivity,
} from "../client/use-message-stream.ts";
import type { AssistantSteer } from "./assistant-body.ts";
import type { ConversationData } from "./conversation-window.ts";
import { epoch, timedActivity, toCompactionActivity } from "./stored-activities.ts";

/** What a streaming answer starts from: its chunks so far, over its durable rows. */
export function streamSeed(
  streamingMessage: ConversationData["messages"][number],
  data: ConversationData,
) {
  const text = data.pendingChunks
    .filter((c) => c.kind === "text")
    .map((c) => c.delta)
    .join("");
  const reasoningChunks = data.pendingChunks.filter((c) => c.kind === "reasoning");
  const reasoning = reasoningChunks.map((c) => c.delta).join("");
  const lastSeq = data.pendingChunks.at(-1)?.seq ?? 0;
  // Seed tool activity from durable rows; live envelopes upsert on top.
  const durableTools = data.toolCalls
    .filter((t) => t.messageId === streamingMessage.id)
    .map(timedActivity);
  // Starts can land between snapshots. Replay explicit anchors for every
  // family; terminal durable activities ignore older progress in the reducer.
  // A deck edit still being written replays too, until its call starts.
  const tools = data.pendingChunks.reduce<ToolActivity[]>(
    (current, chunk) =>
      chunk.kind === "tool" ||
      (chunk.kind === "writing" &&
        !isStaleWriting(chunk.delta, streamingMessage.generationId ?? null))
        ? applyToolActivityChunk(current, chunk.kind, chunk.delta, epoch(chunk.createdAt))
        : current,
    durableTools,
  );
  // Seed durable activity first; replayed chunks then idempotently overlay
  // any terminal marker that landed after the query snapshot.
  const durableCompactions = data.compactionEvents
    .filter((event) => event.messageId === streamingMessage.id)
    .map(toCompactionActivity);
  const compactions = data.pendingChunks
    .filter((c) => c.kind === "compaction")
    .reduce<CompactionActivity[]>(
      (current, c) => applyCompactionChunk(current, c.delta),
      durableCompactions,
    );
  return {
    steers: data.pendingChunks
      .filter((chunk) => chunk.kind === "steer")
      .reduce<AssistantSteer[]>((steers, chunk) => applySteerChunk(steers, chunk.delta), []),
    files: data.pendingChunks
      .filter((chunk) => chunk.kind === "file")
      .reduce<AssistantFile[]>(
        (files, chunk) => applyFileChunk(files, chunk.delta),
        [...(streamingMessage.assistantOutput?.files ?? [])],
      ),
    text,
    reasoning,
    reasoningSeen: reasoningChunks.length > 0,
    tools,
    compactions,
    lookups: lookupsOf(streamingMessage.assistantOutput),
    lastSeq,
  };
}
