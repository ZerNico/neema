// Block state waiting to be saved, for a send to wait on. Saves are debounced
// while a reader clicks, and the next answer reads saved state: without this,
// picking an answer and asking about it at once would show the model the pick
// before. Apart from the block renderer, which loads lazily, so the composer
// can import it.

const flushers = new Set<() => void>();
/** Handler calls still running in the Worker; their new state is not known yet. */
const working = new Set<Promise<unknown>>();
const inFlight = new Set<Promise<void>>();
/** Each block's last save: the next goes after it, so the server sees them in order. */
const chains = new Map<string, Promise<void>>();

/** A save stuck this long must not hold up a send; the answer just reads older state. */
const FLUSH_WAIT_MS = 2_500;

/** Registers a block's flush for as long as it is mounted. */
export function registerBlockFlush(flush: () => void): () => void {
  flushers.add(flush);
  return () => flushers.delete(flush);
}

/** Tracks a handler call, so a send waits for the state it is about to produce. */
export function trackBlockWork(work: Promise<unknown>): void {
  working.add(work);
  void work.finally(() => working.delete(work));
}

/**
 * Sends a block's save after its previous one: two in flight at once could
 * land out of order and leave the older state saved.
 */
export function trackBlockSave(block: string, save: () => Promise<void>): void {
  // Sent at once when nothing is ahead of it: a block unmounting as the page
  // leaves has no microtask to spare.
  const previous = chains.get(block);
  // Never released early: a request given up on could still land after its
  // successor and save the older state for good. A send waits at most its
  // flush deadline either way.
  const next = (previous ? previous.then(save) : save()).catch(() => {});
  chains.set(block, next);
  inFlight.add(next);
  void next.finally(() => {
    inFlight.delete(next);
    if (chains.get(block) === next) chains.delete(block);
  });
}

const settled = (pending: ReadonlySet<Promise<unknown>>, until: Promise<void>) =>
  pending.size === 0 ? Promise.resolve() : Promise.race([Promise.allSettled(pending), until]);

/**
 * Lets running handlers finish, sends every waiting save, and resolves once
 * they have landed or failed, or after a short wait.
 */
export async function flushBlockSaves(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, FLUSH_WAIT_MS);
  });
  await settled(working, deadline);
  for (const flush of flushers) flush();
  await settled(inFlight, deadline);
  clearTimeout(timer);
}
