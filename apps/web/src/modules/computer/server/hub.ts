import { Clock, Context, Effect, Layer, Queue, type Scope, Stream } from "effect";
import type { MachineEvent, MachineHello } from "@chat/desktop-rpc";
import { SyncBus } from "~/modules/sync/server/bus.ts";

/** A machine with its event stream open right now. */
export interface Presence {
  readonly userId: string;
  readonly machineId: string;
  readonly hello: MachineHello;
  /** The desktop session the stream was opened with: the one the machine's own page holds. */
  readonly sessionId: string;
  readonly connectedAt: number;
}

interface Connection extends Presence {
  readonly queue: Queue.Queue<MachineEvent>;
}

const key = (userId: string, machineId: string) => `${userId}\u0000${machineId}`;

/**
 * Whether clients should hear of a new hello. A download reports every percent; every open
 * client refetches on each change, so progress is told in steps of five.
 */
const worthTelling = (before: MachineHello, after: MachineHello) => {
  if (before.name !== after.name || before.remote !== after.remote) return true;
  const was = before.computer;
  const now = after.computer;
  if (was.status !== now.status) return true;
  if (was.status === "preparing" && now.status === "preparing")
    return Math.floor(was.progress * 20) !== Math.floor(now.progress * 20);
  return was.status === "unavailable" && now.status === "unavailable" && was.reason !== now.reason;
};

/**
 * Which machines are connected and the way to each. Presence is in memory: there is one server
 * process, and a machine that loses its stream is offline until it reconnects. A second stream
 * from the same machine replaces the first, so a reconnect after a network change never leaves
 * two paths to one machine.
 */
export class MachineHub extends Context.Service<
  MachineHub,
  {
    /** Registers the machine for the life of the scope and returns its events. */
    connect(
      userId: string,
      hello: MachineHello,
      sessionId: string,
    ): Effect.Effect<Stream.Stream<MachineEvent>, never, Scope.Scope>;
    /** A new hello from a connected machine; false when it is not connected. */
    update(userId: string, hello: MachineHello): Effect.Effect<boolean>;
    /** False when the machine is not connected, so the caller can answer for it. */
    send(userId: string, machineId: string, event: MachineEvent): Effect.Effect<boolean>;
    /** Sends to every connected machine of the person. */
    broadcast(userId: string, event: MachineEvent): Effect.Effect<void>;
    presence(userId: string, machineId: string): Effect.Effect<Presence | null>;
    online(userId: string): Effect.Effect<ReadonlyArray<Presence>>;
    /**
     * The connected machine whose stream holds this session, if any. A request's own claim to
     * come from a machine proves nothing: any session of the person could make it.
     */
    machineOfSession(userId: string, sessionId: string | undefined): Effect.Effect<string | null>;
  }
>()("chat/computer/MachineHub") {
  static readonly layer = Layer.effect(
    MachineHub,
    Effect.gen(function* () {
      const bus = yield* SyncBus;
      const connections = new Map<string, Connection>();
      const changed = (userId: string) => bus.publish(userId, { type: "computer.changed" });
      const presenceOf = ({ queue: _, ...presence }: Connection): Presence => presence;
      return MachineHub.of({
        connect: (userId, hello, sessionId) =>
          Effect.gen(function* () {
            const id = key(userId, hello.machineId);
            const previous = connections.get(id);
            if (previous) yield* Queue.shutdown(previous.queue);
            const queue = yield* Queue.unbounded<MachineEvent>();
            const connection: Connection = {
              userId,
              machineId: hello.machineId,
              hello,
              sessionId,
              connectedAt: yield* Clock.currentTimeMillis,
              queue,
            };
            connections.set(id, connection);
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                // A replacement may already hold the slot; only this connection's own goes.
                if (connections.get(id) === connection) {
                  connections.delete(id);
                  yield* changed(userId);
                }
                yield* Queue.shutdown(queue);
              }),
            );
            yield* changed(userId);
            return Stream.fromQueue(queue);
          }),
        update: (userId, hello) =>
          Effect.gen(function* () {
            const id = key(userId, hello.machineId);
            const current = connections.get(id);
            if (!current) return false;
            connections.set(id, { ...current, hello });
            if (worthTelling(current.hello, hello)) yield* changed(userId);
            return true;
          }),
        send: (userId, machineId, event) =>
          Effect.gen(function* () {
            const connection = connections.get(key(userId, machineId));
            if (!connection) return false;
            return yield* Queue.offer(connection.queue, event);
          }),
        broadcast: (userId, event) =>
          Effect.forEach(
            [...connections.values()].filter((connection) => connection.userId === userId),
            (connection) => Queue.offer(connection.queue, event),
            { discard: true },
          ),
        presence: (userId, machineId) =>
          Effect.sync(() => {
            const connection = connections.get(key(userId, machineId));
            return connection ? presenceOf(connection) : null;
          }),
        online: (userId) =>
          Effect.sync(() =>
            [...connections.values()]
              .filter((connection) => connection.userId === userId)
              .map(presenceOf),
          ),
        machineOfSession: (userId, sessionId) =>
          Effect.sync(() => {
            if (sessionId === undefined) return null;
            for (const connection of connections.values())
              if (connection.userId === userId && connection.sessionId === sessionId)
                return connection.machineId;
            return null;
          }),
      });
    }),
  );
}
