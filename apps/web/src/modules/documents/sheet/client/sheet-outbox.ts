import type { SheetChange } from "@chat/sheet/model/ops";
import type { DeviceCache } from "~/modules/cache/client/device-cache.ts";
import type { SheetOutbox } from "./sheet-sync.ts";

export interface UnsentSheetChange {
  readonly change: SheetChange;
  readonly savedAt: number;
}

/** The prefix of a sheet’s changes, or of one client’s among them. */
const prefixOf = (documentId: string, clientId?: string) =>
  clientId === undefined ? `${documentId}\u0000` : `${documentId}\u0000${clientId}\u0000`;

/** Each change has its own key, so no tab overwrites another’s newer numbers. */
export function sheetOutboxFor(store: DeviceCache<UnsentSheetChange>): SheetOutbox {
  return {
    load: async (documentId) => {
      await store.warm();
      const entries = await store.reloadAll(prefixOf(documentId));
      return entries
        .map(([, entry]) => entry.change)
        .toSorted((a, b) => a.clientId.localeCompare(b.clientId) || a.seq - b.seq);
    },
    add: (documentId, change) =>
      store.set(`${prefixOf(documentId, change.clientId)}${change.seq}`, {
        change,
        savedAt: Date.now(),
      }),
    forget: (documentId, clientId, seq) =>
      store.deleteWhere(prefixOf(documentId, clientId), (entry) => entry.change.seq <= seq),
  };
}
