import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { runServerFn } from "~/server/run-server-fn.ts";
import { ComputerCalls } from "./calls.ts";
import { MachineHub } from "./hub.ts";
import { ComputerRepo } from "./repo.ts";

const standard = Schema.toStandardSchemaV1;
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

/**
 * Everything a client shows about the person's computers: each machine they ever connected and
 * whether it is online and ready, and every call waiting for an answer. Refetched on
 * `computer.changed`.
 */
export const computerSnapshot = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runServerFn(
      Effect.gen(function* () {
        const userId = context.session.user.id;
        const repo = yield* ComputerRepo;
        const hub = yield* MachineHub;
        const calls = yield* ComputerCalls;
        const online = new Map(
          (yield* hub.online(userId)).map((presence) => [presence.machineId, presence]),
        );
        const machines = (yield* repo.machines(userId)).map((machine) => {
          const presence = online.get(machine.id);
          return {
            id: machine.id,
            name: presence?.hello.name ?? machine.name,
            platform: machine.platform,
            lastSeenAt: machine.lastSeenAt.toISOString(),
            online: presence !== undefined,
            computer: presence?.hello.computer ?? null,
            remote: presence?.hello.remote ?? null,
          };
        });
        // Arguments are the model's, of any shape; they cross as JSON text.
        const pending = (yield* calls.pending(userId)).map(({ args, ...call }) => ({
          ...call,
          args: JSON.stringify(args),
        }));
        return { machines, pending };
      }),
    ),
  );

export const decideComputerCall = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(
    standard(
      Schema.Struct({
        callId: Id,
        choice: Schema.Literals(["allow", "deny", "allow-rest", "allow-chat", "allow-everywhere"]),
      }),
    ),
  )
  .handler(({ data, context }) =>
    runServerFn(
      Effect.gen(function* () {
        const calls = yield* ComputerCalls;
        return { decided: yield* calls.decide(context.session.user.id, data.callId, data.choice) };
      }),
    ),
  );

/**
 * The person's own name for one of their machines, so two of the same model can be told apart;
 * blank goes back to the name the machine reports. Any device of theirs may rename any machine.
 */
export const renameComputer = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(
    standard(
      Schema.Struct({
        machineId: Id,
        name: Schema.String.check(Schema.isMaxLength(60)),
      }),
    ),
  )
  .handler(({ data, context }) =>
    runServerFn(
      Effect.gen(function* () {
        const userId = context.session.user.id;
        const label = data.name.trim() || null;
        const shown = yield* (yield* ComputerRepo).renameMachine(userId, data.machineId, label);
        if (shown === null) return { renamed: false };
        yield* (yield* MachineHub).rename(userId, data.machineId, shown);
        yield* (yield* SyncBus).publish(userId, { type: "computer.changed" });
        return { renamed: true };
      }),
    ),
  );

/** Points a chat at another of the person's machines, or at none. Its folders stay behind. */
export const switchChatComputer = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(Schema.Struct({ conversationId: Id, machineId: Schema.NullOr(Id) })))
  .handler(({ data, context }) =>
    runServerFn(
      Effect.gen(function* () {
        const userId = context.session.user.id;
        const repo = yield* ComputerRepo;
        if (data.machineId && !(yield* repo.machine(userId, data.machineId)))
          return { switched: false };
        const switched = yield* repo.rebind(userId, data.conversationId, data.machineId);
        if (switched) {
          yield* (yield* ComputerCalls).forgetAllowances(data.conversationId);
          yield* (yield* SyncBus).publish(userId, { type: "computer.changed" });
        }
        return { switched };
      }),
    ),
  );

/** Throws away what the chat installed: its VM and disk go, its files in /workspace stay. */
export const resetChatEnvironment = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(Schema.Struct({ conversationId: Id })))
  .handler(({ data, context }) =>
    runServerFn(
      Effect.gen(function* () {
        const userId = context.session.user.id;
        const chat = yield* (yield* ComputerRepo).chat(userId, data.conversationId);
        if (!chat?.machineId) return { reset: false };
        const reset = yield* (yield* MachineHub).send(userId, chat.machineId, {
          type: "discard",
          conversationId: data.conversationId,
          workspace: false,
        });
        return { reset };
      }),
    ),
  );

/** The network destinations the person allowed, every chat's and each chat's own. */
export const listNetworkGrants = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runServerFn(
      Effect.gen(function* () {
        return { grants: [...(yield* (yield* ComputerRepo).grants(context.session.user.id))] };
      }),
    ),
  );

export const removeNetworkGrant = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(Schema.Struct({ grantId: Id })))
  .handler(({ data, context }) =>
    runServerFn(
      Effect.gen(function* () {
        const userId = context.session.user.id;
        const removed = yield* (yield* ComputerRepo).removeGrant(userId, data.grantId);
        // The machines drop the grant and close the tunnels it allowed.
        if (removed) yield* (yield* ComputerCalls).pushPolicy(userId);
        return { removed };
      }),
    ),
  );
