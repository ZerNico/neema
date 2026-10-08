import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { sidebarPins } from "~/db/schema/index.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { DEFAULT_PINS, normalizePins, type DestinationId, type SidebarPins } from "../schema.ts";

export class SidebarPinsService extends Context.Service<
  SidebarPinsService,
  {
    get(userId: string): Effect.Effect<SidebarPins>;
    set(userId: string, pinned: ReadonlyArray<DestinationId>): Effect.Effect<SidebarPins>;
  }
>()("chat/navigation/SidebarPinsService") {
  static readonly layer = Layer.effect(
    SidebarPinsService,
    Effect.gen(function* () {
      const db = yield* Db;
      const sync = yield* SyncBus;

      const get = Effect.fn("SidebarPinsService.get")(function* (userId: string) {
        const rows = yield* db
          .select({ pinned: sidebarPins.pinned })
          .from(sidebarPins)
          .where(eq(sidebarPins.userId, userId))
          .limit(1)
          .pipe(Effect.orDie);
        return { pinned: rows[0] ? normalizePins(rows[0].pinned) : [...DEFAULT_PINS] };
      });

      const set = Effect.fn("SidebarPinsService.set")(function* (
        userId: string,
        input: ReadonlyArray<DestinationId>,
      ) {
        const pinned = normalizePins(input);
        yield* db
          .insert(sidebarPins)
          .values({ userId, pinned })
          .onConflictDoUpdate({
            target: sidebarPins.userId,
            set: { pinned, updatedAt: new Date() },
          })
          .pipe(Effect.orDie);
        // Other tabs and the desktop app refetch; a failed publication only
        // delays them until their next reconnect.
        yield* sync
          .publish(userId, { type: "sidebar.changed" })
          .pipe(
            Effect.catchCause(() =>
              Effect.logWarning("sidebar pins changed but sync publication failed", { userId }),
            ),
          );
        return { pinned };
      });

      return SidebarPinsService.of({ get, set });
    }),
  );
}
