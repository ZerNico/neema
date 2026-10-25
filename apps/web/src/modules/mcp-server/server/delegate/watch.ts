import { Duration, Effect, Option, Stream } from "effect";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { StreamEngine, type StreamEvent } from "~/modules/chat/server/streaming.ts";

export type WatchOutcome =
  | { readonly kind: "settled" }
  | { readonly kind: "superseded"; readonly generationId: string | null }
  | { readonly kind: "running" };

/** What a tool start says while it runs, read loosely: progress is a courtesy. */
const describeTool = (delta: string): string | null => {
  try {
    const envelope: unknown = JSON.parse(delta);
    if (typeof envelope !== "object" || envelope === null) return null;
    const { name, phase } = envelope as { name?: unknown; phase?: unknown };
    if (typeof name !== "string") return null;
    if (name === "deep_research") return "Researching";
    return phase === undefined || phase === "start" ? `Using ${name}` : null;
  } catch {
    return null;
  }
};

/**
 * Follows one attempt until it ends, a retry replaces it, or the wait runs
 * out. Only the live tail is read; what came before is the answer's to say.
 * Interrupting this stops the watching, never the generation, which runs
 * apart from any request.
 */
export const watchTurn = Effect.fn("mcp.watchTurn")(function* (input: {
  messageId: string;
  generationId: string;
  wait: Duration.Duration;
  onProgress: (message: string) => Effect.Effect<void>;
}) {
  const repo = yield* ChatRepo;
  const engine = yield* StreamEngine;
  const after = yield* repo.lastChunkSeq(input.messageId);
  let lastProgress: string | null = null;
  const progress = (event: StreamEvent) => {
    if (event.kind !== "chunk" || event.chunkKind !== "tool") return Effect.void;
    const message = describeTool(event.delta);
    if (!message || message === lastProgress) return Effect.void;
    lastProgress = message;
    return input.onProgress(message);
  };
  const done = yield* engine.subscribe(input.messageId, after, input.generationId).pipe(
    Stream.tap(progress),
    Stream.filter((event) => event.kind === "done"),
    Stream.runHead,
    Effect.timeoutOption(input.wait),
  );
  if (Option.isNone(done)) return { kind: "running" } satisfies WatchOutcome;
  const event = Option.flatten(done);
  // The engine ends a subscription at once, naming the new attempt, when a
  // retry has replaced the one asked for.
  if (Option.isSome(event) && event.value.kind === "done") {
    const generationId = event.value.generationId;
    if (generationId !== undefined && generationId !== input.generationId)
      return { kind: "superseded", generationId } satisfies WatchOutcome;
  }
  return { kind: "settled" } satisfies WatchOutcome;
});
