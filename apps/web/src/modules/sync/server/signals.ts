import { sql } from "drizzle-orm";
import { Effect, Schema } from "effect";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import { SyncEnvelope } from "../events.ts";

// Internal wakeups share the transport, never the browser event contract.
export const WorkSignal = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["research.chunks", "research.control"]),
    messageId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("knowledge.work"),
    stage: Schema.Literals(["extraction", "embedding"]),
  }),
]);
export type WorkSignal = typeof WorkSignal.Type;
export const Notification = Schema.Union([
  SyncEnvelope,
  Schema.Struct({ scope: Schema.Literal("internal"), event: WorkSignal }),
]);
export type Notification = typeof Notification.Type;
export const NOTIFICATION_CHANNEL = "chat_sync";

// PgClient.notify acquires another connection, even inside a transaction.
// Executing on the writer's handle makes Postgres deliver only after commit.
export const notifyOnCommit = (tx: Pick<DbTx, "execute">, notification: Notification) =>
  tx
    .execute(sql`select pg_notify(${NOTIFICATION_CHANNEL}, ${JSON.stringify(notification)})`)
    .pipe(Effect.orDie, Effect.asVoid);
