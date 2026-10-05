import type { PgClient } from "@effect/sql-pg";
import { Cause, Duration, Effect, Queue, Redacted, Stream } from "effect";
import { Client } from "pg";
import { NOTIFICATION_CHANNEL } from "./signals.ts";

export type NotificationFrame = { type: "ready" } | { type: "payload"; payload: string };

/**
 * The adapter's listen stream ignores socket errors. Own this connection so
 * reconnects can announce readiness and every consumer can reconcile its gap.
 */
export const listenNotifications = (config: PgClient.PgClientConfig) =>
  Stream.callback<NotificationFrame, Error>((queue) =>
    Effect.gen(function* () {
      // The pool may take the password as an effect it re-reads on each
      // connection attempt (rotating credentials); every reconnect here does too.
      const password = Effect.isEffect(config.password) ? yield* config.password : config.password;
      const client = new Client({
        connectionString: config.url ? Redacted.value(config.url) : undefined,
        host: config.host,
        port: config.port,
        user: config.username,
        password: password ? Redacted.value(password) : undefined,
        database: config.database,
        ssl: config.ssl,
        application_name: "chat-notifications",
        connectionTimeoutMillis: 10_000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10_000,
      });
      const failed = (error: Error) => Queue.failCauseUnsafe(queue, Cause.fail(error));
      const ended = () => failed(new Error("Notification connection ended"));
      client.on("error", failed);
      client.on("end", ended);
      client.on("notification", (message) => {
        if (message.channel === NOTIFICATION_CHANNEL && message.payload)
          Queue.offerUnsafe(queue, { type: "payload", payload: message.payload });
      });
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => client.end()).pipe(
          Effect.timeoutOption(Duration.seconds(2)),
          Effect.catchCause(() => Effect.void),
        ),
      );
      yield* Effect.tryPromise({
        try: () => client.connect(),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      });
      yield* Effect.tryPromise({
        try: () => client.query(`LISTEN ${NOTIFICATION_CHANNEL}`),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      });
      Queue.offerUnsafe(queue, { type: "ready" });
    }),
  );
