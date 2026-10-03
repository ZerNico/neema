import { decodeReplayUnit, isEmptyUnit, type ReplayUnit } from "@chat/model-client";
import { ASSISTANT_FILE_LIMITS } from "../assistant-output.ts";

/**
 * An answer's opaque provider state, one replay unit per model round that
 * returned any: reasoning details and signatures, encrypted reasoning, thought
 * signatures. Each turn covers the span of the answer's text that round wrote,
 * so history can rebuild the round around it; an image answer records every
 * round, unit or not, since its files are placed by round. Never sent to a
 * client: the detail loader and the live stream both leave it out.
 */
export interface ProviderReplay {
  v: 1;
  turns: ReadonlyArray<{
    turnIndex: number;
    startOffset: number;
    endOffset: number;
    unit: ReplayUnit | null;
  }>;
}

/** A round's unit from a finish part, validated; never trusts provider metadata as stored shape. */
export const replayUnitOf = (value: unknown): ReplayUnit | null => {
  const unit = decodeReplayUnit(value);
  return unit && !isEmptyUnit(unit) ? unit : null;
};

/**
 * Bounds what one answer keeps. Past the limit the newest round is dropped
 * rather than the answer failing: replay is an optimisation for every
 * service but those that require it, and those reject the next request with
 * a reason the error path already reports.
 */
export const appendReplay = (
  replay: ProviderReplay | null | undefined,
  turn: ProviderReplay["turns"][number],
): ProviderReplay | null => {
  const next: ProviderReplay = { v: 1, turns: [...(replay?.turns ?? []), turn] };
  return Buffer.byteLength(JSON.stringify(next), "utf8") > ASSISTANT_FILE_LIMITS.replayBytes
    ? (replay ?? null)
    : next;
};
