import { deviceCache } from "~/modules/cache/client/device-cache.ts";

/**
 * Changes this device made that the server may not have yet: the steps,
 * the document they were made on and the revision it was at, and the collab
 * client id that sent them, so the server's copies are recognised as ours.
 */
export interface OutboxEntry {
  clientId: string;
  revision: number;
  doc: Record<string, unknown>;
  steps: string[];
  /** Text from steps that could no longer be placed, kept until the person dismisses it. */
  recovered?: string;
  savedAt: number;
}

export interface OutboxStore {
  warm(): Promise<void>;
  get(documentId: string): OutboxEntry | undefined;
  /** The entry as stored now, which another tab may have written. */
  reload(documentId: string): Promise<OutboxEntry | undefined>;
  /** Every stored entry under a key prefix, which other tabs may have written. */
  reloadAll(prefix: string): Promise<Array<[string, OutboxEntry]>>;
  /** Writes pending changes, so another tab reading after this sees them. */
  flush(): Promise<void>;
  set(documentId: string, entry: OutboxEntry): void;
  delete(documentId: string): void;
}

/**
 * Kept on the device so a reload, a crash or a discarded tab does not lose
 * typing the server never got. Still a cache: losing an entry costs only
 * those unsent changes, which is all an open tab ever protected before.
 */
export const outbox: OutboxStore = deviceCache<OutboxEntry>({
  namespace: "document-outbox",
  // Unsent typing, not a cache: never evicted, whatever its size.
  keep: true,
  maxBytes: 16 * 1024 * 1024,
});
