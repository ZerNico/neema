import { Effect, PubSub, Semaphore } from "effect";
import type { JsonValue } from "~/db/schema/providers.ts";
import {
  emptyUsageTotals,
  resolveCost,
  type UsageTotals,
} from "~/modules/analytics/server/usage.ts";
import type { ProviderRepo } from "~/modules/providers/server/repo.ts";
import type { SyncBus } from "~/modules/sync/server/bus.ts";
import type { ToolChunkEnvelope } from "~/modules/tools/schema.ts";
import type { CompactionChunkEnvelope } from "../../schema.ts";
import { GenerationSettled, type GenerationIdentity } from "../generation-fence.ts";
import type { ChatRepo, ChunkKind } from "../repo.ts";
import type { PreviewEvent, StatusEvent, StreamEvent } from "./events.ts";

/**
 * Message and tool-call rows are shipped to the client wholesale, so the
 * stored error must not carry provider stack traces or internal URLs. The
 * full cause goes to the server log instead (see finalize).
 */
export const shortErrorMessage = (error: unknown): string =>
  String(error).split("\n", 1)[0]!.slice(0, 200);

/**
 * What one attempt spent, filled in by its rounds and read once at finalize.
 * It lives outside the generation effect: a stopped generation is interrupted
 * mid-effect, and the tokens it already burned still have to be recorded. A
 * turn interrupted before its finish part contributes nothing, since the
 * provider never sent the numbers.
 */
export interface AttemptUsage {
  readonly totals: UsageTotals;
  /**
   * The estimator's calibration pair, persisted at finalize: what the
   * provider counted for the first model call, and what we predicted for
   * that same prompt. Only the first call maps onto one prompt;
   * `totals.inputTokens` sums every tool round.
   */
  sawFirstFinish: boolean;
  firstInputTokens: number | undefined;
  estimatedFirstInputTokens: number | undefined;
  /** A model call has started and not yet reported its finish. */
  modelCallOpen: boolean;
  imageCostIncomplete: boolean;
}

export const makeAttemptUsage = (): AttemptUsage => ({
  totals: emptyUsageTotals(),
  sawFirstFinish: false,
  firstInputTokens: undefined,
  estimatedFirstInputTokens: undefined,
  modelCallOpen: false,
  imageCostIncomplete: false,
});

/**
 * Everything one attempt writes to its answer's stream: the numbered chunks,
 * the live-only events, and the final row. It owns `seq`, the buffer and the
 * assembled text, so the persist-then-publish rule lives in one place.
 */
export const makeGenerationSink = (input: {
  repo: ChatRepo["Service"];
  sync: SyncBus["Service"];
  pubsub: PubSub.PubSub<StreamEvent>;
  statuses: Map<string, StatusEvent>;
  previews: Map<string, Map<string, PreviewEvent>>;
  fence: GenerationIdentity | null;
  userId: string;
  conversationId: string;
  messageId: string;
  modelId: string;
  model: Effect.Success<ReturnType<ProviderRepo["Service"]["getModel"]>>;
  imageOutput: boolean;
  usage: AttemptUsage;
  /** A resumed answer's usage so far, which the row's totals include. */
  earlierUsage: { readonly inputTokens?: number; readonly outputTokens?: number } | null;
  /** Where a resumed answer left off; zero and empty for a new one. */
  start: { seq: number; text: string; reasoning: string; deliveredFiles: number };
}) =>
  Effect.gen(function* () {
    const { repo, pubsub, statuses, previews, fence, usage } = input;
    let seq = input.start.seq;
    let assembled = input.start.text;
    let assembledReasoning = input.start.reasoning;
    // Anything the answer delivered counts as output, including what a
    // resumed answer already holds, so a files-only answer is not empty.
    let deliveredFiles = input.start.deliveredFiles;
    let buffer: Array<{ seq: number; kind: ChunkKind; delta: string }> = [];
    let wroteWords = false;

    // Persist first, then publish: a subscriber's one-shot DB replay must
    // never miss a chunk already announced live. Uninterruptible from the
    // buffer swap on: the flusher races the generation finishing, and an
    // interrupt between clearing the buffer and inserting would lose that
    // seq range, breaking the contiguity resume relies on.
    const writer = yield* Semaphore.make(1);
    const flush = writer.withPermits(1)(
      Effect.uninterruptible(
        Effect.suspend(() => {
          const batch = buffer;
          buffer = [];
          // Nothing to write still renews the lease for ordinary chat, so a
          // slow first token or a long tool round cannot get the row reaped
          // mid-answer. Research keeps its own lease on the run.
          if (batch.length === 0)
            return fence
              ? repo.renewGenerationLease(input.messageId, fence.generationId)
              : Effect.void;
          if (batch.some((chunk) => chunk.kind === "text" || chunk.kind === "reasoning"))
            wroteWords = true;
          return repo.appendChunks(input.messageId, batch).pipe(
            Effect.flatMap(() =>
              Effect.forEach(
                batch,
                (chunk) =>
                  PubSub.publish(pubsub, {
                    kind: "chunk",
                    ...(fence ? { generationId: fence.generationId } : {}),
                    messageId: input.messageId,
                    seq: chunk.seq,
                    chunkKind: chunk.kind,
                    delta: chunk.delta,
                  }),
                { discard: true },
              ),
            ),
          );
        }),
      ),
    );

    const push = (kind: ChunkKind, delta: string) => {
      seq += 1;
      if (kind === "reasoning") assembledReasoning += delta;
      else if (kind === "text") assembled += delta;
      buffer.push({ seq, kind, delta });
    };

    /**
     * A file chunk is written by the record that stores its file, under the
     * writer, at the next seq. Its position is read as the call is made; the
     * seq advances and the chunk is published only once the record committed.
     */
    const fileChunk = <A, E, R>(
      write: (at: { seq: number; textOffset: number }) => Effect.Effect<A, E, R>,
      options: { countsAsDelivered: boolean },
    ) =>
      writer.withPermits(1)(
        write({ seq: seq + 1, textOffset: assembled.length }).pipe(
          Effect.tap((written) =>
            Effect.gen(function* () {
              seq += 1;
              if (options.countsAsDelivered) deliveredFiles += 1;
              yield* PubSub.publish(pubsub, {
                kind: "chunk",
                messageId: input.messageId,
                ...(fence ? { generationId: fence.generationId } : {}),
                seq,
                chunkKind: "file",
                delta: JSON.stringify(written),
              });
            }),
          ),
          Effect.uninterruptible,
        ),
      );

    /** Stores lookups under the fence, then tells subscribers everything found so far. */
    const recordLookups = (
      owner: GenerationIdentity,
      update: Parameters<typeof repo.recordUiLookups>[1],
    ) =>
      repo.recordUiLookups(owner, update).pipe(
        Effect.flatMap((lookups) =>
          PubSub.publish(pubsub, {
            kind: "lookups",
            messageId: input.messageId,
            generationId: owner.generationId,
            lookups,
          }),
        ),
        Effect.asVoid,
      );

    const publishStatus = (reading: StatusEvent["reading"]) =>
      Effect.suspend(() => {
        const event: StatusEvent = {
          ...(fence ? { generationId: fence.generationId } : {}),
          messageId: input.messageId,
          reading,
        };
        if (reading) statuses.set(input.messageId, event);
        // Only this attempt's own line: a stale attempt must not clear a newer one's.
        else if (statuses.get(input.messageId)?.generationId === event.generationId)
          statuses.delete(input.messageId);
        return PubSub.publish(pubsub, { kind: "status", ...event });
      });

    const publishPreview = (callId: string, image: { mediaType: string; data: Uint8Array }) =>
      Effect.gen(function* () {
        if (!fence) return;
        const event: PreviewEvent = {
          messageId: input.messageId,
          generationId: fence.generationId,
          callId,
          mediaType: image.mediaType,
          data: Buffer.from(image.data).toString("base64"),
        };
        const calls = previews.get(input.messageId) ?? new Map();
        calls.set(callId, event);
        previews.set(input.messageId, calls);
        yield* PubSub.publish(pubsub, { kind: "preview", ...event });
      });

    const pushTool = (envelope: ToolChunkEnvelope) =>
      Effect.suspend(() => {
        push("tool", JSON.stringify(envelope));
        return flush; // tool markers flush immediately so the UI reacts
      });

    const pushCompaction = (envelope: CompactionChunkEnvelope) =>
      Effect.suspend(() => {
        push("compaction", JSON.stringify(envelope));
        return flush; // same reason as tool markers, only more so: this
      }); //          is the only thing on screen while it runs

    // Each call's full arguments, kept for a week only if it ends in error.
    const debugArgs = new Map<string, JsonValue>();
    const finalize = (status: "complete" | "error" | "aborted", error?: unknown) =>
      Effect.gen(function* () {
        yield* flush;
        if (error) {
          yield* Effect.logError("generation failed", {
            messageId: input.messageId,
            cause: String(error),
          });
          yield* repo.failRunningToolCalls(input.messageId, shortErrorMessage(error));
          yield* repo.failRunningCompactionEvents(input.messageId, shortErrorMessage(error));
        } else if (status === "aborted") {
          // A tool interrupted mid-flight never reports back; without this
          // its row would stay "running" forever.
          yield* repo.failRunningToolCalls(input.messageId, "stopped");
          yield* repo.failRunningCompactionEvents(input.messageId, "stopped");
        }
        // Every call is settled by now, those interrupted included.
        yield* repo
          .keepFailedCallArguments([...debugArgs].map(([id, value]) => ({ id, arguments: value })))
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError("keeping failed call arguments failed", cause),
            ),
          );
        const { totals, firstInputTokens, estimatedFirstInputTokens, modelCallOpen } = usage;
        yield* repo.finalizeMessage({
          messageId: input.messageId,
          status,
          content: assembled,
          reasoning: assembledReasoning,
          ...(totals.sawUsage
            ? {
                usage: {
                  // The row's text spans every attempt of a resumed answer,
                  // so its usage does too; the ledger keeps one row per attempt.
                  inputTokens: (input.earlierUsage?.inputTokens ?? 0) + totals.inputTokens,
                  outputTokens: (input.earlierUsage?.outputTokens ?? 0) + totals.outputTokens,
                  // Only useful as a pair; either alone calibrates nothing.
                  ...(firstInputTokens !== undefined && estimatedFirstInputTokens !== undefined
                    ? { firstInputTokens, estimatedFirstInputTokens }
                    : {}),
                },
              }
            : {}),
          ...(error
            ? { error: { tag: "GenerationFailed", message: shortErrorMessage(error) } }
            : {}),
          ledger: {
            userId: input.userId,
            kind: "chat",
            modelId: input.modelId,
            modelName: input.model?.displayName ?? input.modelId,
            conversationId: input.conversationId,
            messageId: input.messageId,
            status,
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            cachedInputTokens: totals.cachedInputTokens,
            cacheWriteTokens: totals.cacheWriteTokens,
            reasoningTokens: totals.reasoningTokens,
            // Stopped or failed inside a model call: that call's tokens were
            // billed but never reported, so the row is a floor, not a total.
            // The rounds that did finish keep their known cost.
            usageComplete: !modelCallOpen,
            ...resolveCost(
              totals,
              input.model?.pricing,
              input.imageOutput && (usage.imageCostIncomplete || modelCallOpen)
                ? "incomplete-images"
                : input.imageOutput
                  ? "images"
                  : "text",
            ),
          },
        });
        yield* PubSub.publish(pubsub, {
          kind: "done",
          messageId: input.messageId,
          ...(fence ? { generationId: fence.generationId } : {}),
          status,
        });
        yield* input.sync.publish(input.userId, {
          type: "message.status",
          conversationId: input.conversationId,
          messageId: input.messageId,
          status,
        });
        yield* (yield* GenerationSettled)({
          userId: input.userId,
          conversationId: input.conversationId,
          messageId: input.messageId,
          status,
        });
      });

    return {
      /** The answer's text so far, a resumed answer's earlier text included. */
      text: () => assembled,
      /** Chunks pushed but not yet written. */
      buffered: () => buffer.length,
      /**
       * No text or reasoning written yet. The first words are flushed at once
       * rather than at the next periodic flush, which is most of the wait for them.
       */
      awaitingFirstWords: () => !wroteWords,
      deliveredFiles: () => deliveredFiles,
      countDeliveredFile: () => {
        deliveredFiles += 1;
      },
      push,
      flush,
      pushTool,
      pushCompaction,
      fileChunk,
      recordLookups,
      publishStatus,
      publishPreview,
      clearPreview: (callId: string) => {
        previews.get(input.messageId)?.delete(callId);
      },
      keepDebugArguments: (rowId: string, value: JsonValue) => {
        debugArgs.set(rowId, value);
      },
      finalize,
    };
  });

export type GenerationSink = Effect.Success<ReturnType<typeof makeGenerationSink>>;
