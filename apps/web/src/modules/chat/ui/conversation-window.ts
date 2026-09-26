/** The per-message lists a head and every older page carry. */
interface Rows {
  messages: ReadonlyArray<unknown>;
  toolCalls: ReadonlyArray<unknown>;
  compactionEvents: ReadonlyArray<unknown>;
  attachments: ReadonlyArray<unknown>;
  generations: ReadonlyArray<unknown>;
  priorSources: ReadonlyArray<unknown>;
}

/**
 * The head joined with the older pages loaded above it, as one contiguous
 * suffix of the conversation. Pages come newest first; every per-message list
 * is laid out oldest first, like the head's own. `hasOlder` says whether the
 * suffix still stops short of the first message.
 */
export function withHistory<Head extends Rows & { window: { olderCursor: string | null } }>(
  head: Head,
  pages: ReadonlyArray<Pick<Head, keyof Rows> & { olderCursor: string | null }> | undefined,
): Head & { hasOlder: boolean } {
  if (!pages?.length) return { ...head, hasOlder: head.window.olderCursor !== null };
  const all = [...pages.toReversed(), head];
  const joined = <K extends keyof Rows>(key: K) =>
    all.flatMap((part): ReadonlyArray<unknown> => part[key]) as Head[K];
  return {
    ...head,
    messages: joined("messages"),
    toolCalls: joined("toolCalls"),
    compactionEvents: joined("compactionEvents"),
    attachments: joined("attachments"),
    generations: joined("generations"),
    priorSources: joined("priorSources"),
    hasOlder: pages.at(-1)!.olderCursor !== null,
  };
}
