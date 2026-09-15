import type { ConversationDocument } from "../schema.ts";

export interface DocumentReconciliation {
  document: ConversationDocument;
  content: string;
  conflict: boolean;
}

/**
 * Source edits are one whole value. A newer remote value may replace a clean
 * editor, but two different dirty values need an explicit choice.
 */
export function reconcileDocument(
  previous: ConversationDocument | null,
  incoming: ConversationDocument,
  local: string,
  conflict: boolean,
  pending: string | null = null,
): DocumentReconciliation {
  if (previous && incoming.revision <= previous.revision)
    return { document: previous, content: local, conflict };
  if (!previous) return { document: incoming, content: incoming.content, conflict: false };
  if (local === incoming.content)
    return { document: incoming, content: local, conflict: false };
  // The reply can acknowledge the value sent while a later keystroke remains
  // local. It is our write, not a competing whole-document edit.
  if (pending !== null && pending === incoming.content)
    return { document: incoming, content: local, conflict: false };
  if (incoming.content === previous.content)
    return { document: incoming, content: local, conflict };
  if (local === previous.content)
    return { document: incoming, content: incoming.content, conflict: false };
  return { document: incoming, content: local, conflict: true };
}
