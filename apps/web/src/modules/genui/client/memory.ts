// A block's last tree and state, outside React. Streamdown remounts its
// renderers when an answer finishes and the transcript virtualizes rows away,
// so a block's component comes and goes; what the reader set must not.

import { hashSource } from "../fences.ts";
import type { RenderReply } from "./engine.ts";

interface Remembered {
  readonly hash: string;
  /** Source length, to tell a block still being written from a replaced one. */
  readonly length: number;
  readonly state: string | null;
  readonly reply: RenderReply | null;
}

const MAX_REMEMBERED = 500;
const memory = new Map<string, Remembered>();

/** The block's memory, if it is for exactly this source. */
export function recall(block: string, code: string): Remembered | undefined {
  const entry = memory.get(block);
  return entry && entry.length === code.length && entry.hash === hashSource(code)
    ? entry
    : undefined;
}

/**
 * State to start a fresh runtime from. A block still streaming extends its
 * remembered source and keeps its state; a retry's block replaces it and
 * starts from its own initial state.
 */
export function recallState(block: string, code: string): string | null {
  const entry = memory.get(block);
  if (!entry || entry.length > code.length) return null;
  return entry.hash === hashSource(code.slice(0, entry.length)) ? entry.state : null;
}

export function remember(block: string, code: string, reply: RenderReply): void {
  const previous = memory.get(block);
  const hash = hashSource(code);
  memory.delete(block);
  memory.set(block, {
    hash,
    length: code.length,
    state: reply.ok ? reply.state : (previous?.state ?? null),
    reply: reply.ok || previous?.hash !== hash ? reply : previous.reply,
  });
  if (memory.size > MAX_REMEMBERED) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
}
