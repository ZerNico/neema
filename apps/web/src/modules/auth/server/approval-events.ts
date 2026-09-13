import { Stream } from "effect";
import type { SyncBus } from "~/modules/sync/server/bus.ts";

export const approvalEvents = (bus: SyncBus["Service"], userId: string) =>
  bus.subscribe(userId, true).pipe(
    Stream.filter(
      (event) => event.type === "account.approval.changed" || event.type === "sync.ready",
    ),
    Stream.map(() => null),
  );
