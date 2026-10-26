import { Clock, Context, Effect, Layer, type Scope } from "effect";
import type { ToolResult } from "@chat/desktop-rpc";
import { canonicalHost } from "@chat/egress-proxy";
import { desktopFailure, type DesktopToolResult } from "~/modules/desktop/tool-schema.ts";
import { ExternalCompletion } from "~/modules/tools/server/external-completion.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { MachineHub } from "./hub.ts";
import { sentFilePaths } from "./files.ts";
import { ComputerRepo } from "./repo.ts";

/** What a call asks before it runs. `bind` chooses the chat's machine. */
export type ComputerApproval = "bind" | "edit" | "command" | "delete" | "network";

/** An answer to an approval card. Not every kind offers every answer. */
export type ComputerChoice = "allow" | "deny" | "allow-rest" | "allow-chat" | "allow-everywhere";

/** A call waiting for its person, as every client shows it. */
export interface PendingCall {
  readonly callId: string;
  readonly conversationId: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly approval: ComputerApproval;
  /** For `bind`: the machine the chat would use. */
  readonly machine?: { readonly id: string; readonly name: string };
}

interface Entry {
  readonly userId: string;
  readonly conversationId: string;
  readonly callId: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly deadlineAt: number;
  /** The machine the sender typed on, when the sender is a desktop app. */
  readonly sender: string | undefined;
  state:
    | { readonly kind: "deciding" }
    | {
        readonly kind: "waiting";
        readonly approval: ComputerApproval;
        readonly machine?: { id: string; name: string };
      }
    | { readonly kind: "sent"; readonly machineId: string }
    | { readonly kind: "done" };
}

/** Tools the server answers itself: approving them is the whole of what they do. */
const SERVER_TOOLS = new Set(["request_network_access"]);

/**
 * Tools that ask the person at the machine itself, in a native dialog: a folder on its disk, its
 * SSH agent. They run only for a message sent from that machine, so another device holding the
 * person's session can never open the machine's own resources.
 */
const AT_MACHINE = new Set(["request_folder", "request_ssh_agent"]);

const declined = () =>
  desktopFailure("You declined that", "The user declined. Do not retry it or work around it.");

const approvalFor = (
  name: string,
  args: Readonly<Record<string, unknown>>,
): ComputerApproval | null => {
  switch (name) {
    case "write_local_file":
    case "edit_local_file":
    case "move_local_file":
      return "edit";
    // Into the workspace under a fresh name nothing is overwritten; to a chosen path it is a write.
    case "save_to_workspace":
      return typeof args.path === "string" && args.path ? "edit" : null;
    case "delete_local_file":
      return "delete";
    case "run_command":
      return "command";
    case "request_network_access":
      return "network";
    default:
      return null;
  }
};

/** The destination a network request names, validated the way the proxy will see it. */
export const requestedDestination = (args: Readonly<Record<string, unknown>>) => {
  const host = typeof args.host === "string" ? canonicalHost(args.host.trim()) : null;
  const port = args.port === undefined ? 443 : args.port;
  if (!host?.ok || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535)
    return null;
  return { host: host.host, port, privateNetwork: args.privateNetwork === true };
};

/**
 * Calls of chats' computers, from the moment the model makes one until it ends. Each is decided
 * here: run, ask the person, or answer for a machine that is not there. Approval is a state of
 * the call, held while its generation lives, so any device of the person can answer it. A call
 * that runs goes to the chat's machine; its result completes the handler's wait.
 */
export class ComputerCalls extends Context.Service<
  ComputerCalls,
  {
    /** Takes charge of a call whose wait is already open; ends with the call's scope. */
    open(input: {
      userId: string;
      conversationId: string;
      callId: string;
      name: string;
      args: Readonly<Record<string, unknown>>;
      timeoutMs: number;
      sender?: string | undefined;
    }): Effect.Effect<void, never, Scope.Scope>;
    decide(userId: string, callId: string, choice: ComputerChoice): Effect.Effect<boolean>;
    pending(userId: string): Effect.Effect<ReadonlyArray<PendingCall>>;
    /** A machine's answer; refused unless that machine was sent the call. */
    result(
      userId: string,
      machineId: string,
      callId: string,
      result: ToolResult,
    ): Effect.Effect<boolean>;
    /** Sends the person's grants to one machine, or to all of theirs. */
    pushPolicy(userId: string, machineId?: string): Effect.Effect<void>;
  }
>()("chat/computer/ComputerCalls") {
  static readonly layer = Layer.effect(
    ComputerCalls,
    Effect.gen(function* () {
      const hub = yield* MachineHub;
      const repo = yield* ComputerRepo;
      const external = yield* ExternalCompletion;
      const bus = yield* SyncBus;
      const entries = new Map<string, Entry>();
      /** Kinds a person allowed for the rest of a chat, until the server restarts. */
      const blanket = new Set<string>();

      const changed = (userId: string) => bus.publish(userId, { type: "computer.changed" });

      const finish = (entry: Entry, result: DesktopToolResult) =>
        Effect.gen(function* () {
          if (entry.state.kind === "done") return false;
          entry.state = { kind: "done" };
          const accepted = yield* external.complete(entry.callId, result);
          yield* changed(entry.userId);
          return accepted;
        });

      const pushPolicy = (userId: string, machineId?: string) =>
        Effect.gen(function* () {
          const grants = yield* repo.grants(userId);
          const targets = machineId
            ? [machineId]
            : (yield* hub.online(userId)).map((presence) => presence.machineId);
          for (const target of targets) yield* hub.send(userId, target, { type: "grants", grants });
        });

      const wait = (
        entry: Entry,
        approval: ComputerApproval,
        machine?: { id: string; name: string },
      ) =>
        Effect.gen(function* () {
          entry.state = machine
            ? { kind: "waiting", approval, machine }
            : { kind: "waiting", approval };
          yield* changed(entry.userId);
        });

      /** Where a call goes next: a question, the machine, or an answer for an absent one. */
      const advance = (entry: Entry): Effect.Effect<void> =>
        Effect.gen(function* () {
          const chat = yield* repo.chat(entry.userId, entry.conversationId);
          if (!chat) {
            yield* finish(entry, desktopFailure("That chat is gone", "The chat no longer exists."));
            return;
          }
          const approval = approvalFor(entry.name, entry.args);
          if (SERVER_TOOLS.has(entry.name)) {
            if (entry.name === "request_network_access" && !requestedDestination(entry.args)) {
              yield* finish(
                entry,
                desktopFailure(
                  "That destination could not be read",
                  "Name a host (a domain or an IP address) and a port between 1 and 65535.",
                ),
              );
              return;
            }
            yield* wait(entry, approval!);
            return;
          }
          if (!chat.machineId) {
            const online = yield* hub.online(entry.userId);
            const ready = online.filter((presence) => presence.hello.computer.status === "ready");
            const candidate =
              ready.find((presence) => presence.machineId === entry.sender) ?? ready[0];
            if (!candidate) {
              yield* finish(
                entry,
                desktopFailure(
                  "No computer is connected",
                  "This chat has no computer yet and none of the user's desktop apps is online and ready. Tell the user to open the desktop app.",
                ),
              );
              return;
            }
            yield* wait(entry, "bind", { id: candidate.machineId, name: candidate.hello.name });
            return;
          }
          const presence = yield* hub.presence(entry.userId, chat.machineId);
          if (!presence) {
            const machine = yield* repo.machine(entry.userId, chat.machineId);
            const name = machine?.name ?? "This chat's computer";
            yield* finish(
              entry,
              desktopFailure(
                `${name} is offline`,
                `${name} is not connected${machine ? ` (last seen ${machine.lastSeenAt.toISOString()})` : ""}, so nothing on it can be read or run. Continue from what this chat already has, or tell the user to open the desktop app.`,
              ),
            );
            return;
          }
          const status = presence.hello.computer;
          if (status.status !== "ready") {
            yield* finish(
              entry,
              desktopFailure(
                `${presence.hello.name} is not ready`,
                status.status === "preparing"
                  ? `${presence.hello.name} is still downloading its environment (${Math.round(status.progress * 100)}%). Try again in a few minutes.`
                  : `${presence.hello.name} cannot run this chat's computer: ${status.reason}`,
              ),
            );
            return;
          }
          if (entry.sender !== chat.machineId && !presence.hello.remote) {
            yield* finish(
              entry,
              desktopFailure(
                `${presence.hello.name} does not allow remote use`,
                `This chat's computer only runs calls sent from ${presence.hello.name} itself. Tell the user to continue there, or to allow remote control in its settings.`,
              ),
            );
            return;
          }
          if (AT_MACHINE.has(entry.name) && entry.sender !== chat.machineId) {
            yield* finish(
              entry,
              desktopFailure(
                `Only at ${presence.hello.name}`,
                `This asks the user at ${presence.hello.name} itself, and this message came from another device. Ask them to attach the folder or allow the SSH agent there.`,
              ),
            );
            return;
          }
          if (
            approval === "delete" ||
            ((approval === "edit" || approval === "command") &&
              chat.permissionLevel === "ask" &&
              !blanket.has(`${entry.conversationId}\u0000${approval}`))
          ) {
            yield* wait(entry, approval);
            return;
          }
          yield* send(entry, chat.machineId);
        });

      const send = (entry: Entry, machineId: string) =>
        Effect.gen(function* () {
          const files = yield* repo.sentFiles(entry.userId, entry.conversationId);
          const delivered = yield* hub.send(entry.userId, machineId, {
            type: "call",
            callId: entry.callId,
            conversationId: entry.conversationId,
            name: entry.name,
            args: entry.args,
            deadlineAt: entry.deadlineAt,
            sentAt: yield* Clock.currentTimeMillis,
            attachments: sentFilePaths(files),
          });
          if (!delivered) {
            yield* finish(
              entry,
              desktopFailure(
                "The computer went offline",
                "The desktop app disconnected before the call could run. Do not assume it ran.",
              ),
            );
            return;
          }
          entry.state = { kind: "sent", machineId };
          yield* changed(entry.userId);
        });

      /** What approving a server tool does, and what the model is told. */
      const grant = (entry: Entry, choice: ComputerChoice) =>
        Effect.gen(function* () {
          const destination = requestedDestination(entry.args)!;
          const everywhere = choice === "allow-everywhere";
          yield* repo.addGrant(entry.userId, {
            conversationId: everywhere ? null : entry.conversationId,
            ...destination,
          });
          yield* pushPolicy(entry.userId);
          const where = `${destination.host}:${destination.port}`;
          return yield* finish(entry, {
            v: 1,
            ok: true,
            summary: `Allowed ${where}${everywhere ? " in every chat" : ""}`,
            detail: `Commands may now reach ${where}${everywhere ? " in every chat" : " in this chat"}. Retry the command.`,
            truncated: false,
          });
        });

      return ComputerCalls.of({
        open: (input) =>
          Effect.gen(function* () {
            const entry: Entry = {
              userId: input.userId,
              conversationId: input.conversationId,
              callId: input.callId,
              name: input.name,
              args: input.args,
              deadlineAt: (yield* Clock.currentTimeMillis) + input.timeoutMs,
              sender: input.sender,
              state: { kind: "deciding" },
            };
            entries.set(input.callId, entry);
            // The call's scope ends with its result, Stop, or the generation ending: a call still
            // on a machine is cancelled there, and the card disappears everywhere.
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                entries.delete(entry.callId);
                const state = entry.state;
                entry.state = { kind: "done" };
                if (state.kind === "sent")
                  yield* hub.send(entry.userId, state.machineId, {
                    type: "cancel",
                    callId: entry.callId,
                  });
                if (state.kind !== "done") yield* changed(entry.userId);
              }),
            );
            yield* advance(entry);
          }),
        decide: (userId, callId, choice) =>
          Effect.gen(function* () {
            const entry = entries.get(callId);
            if (!entry || entry.userId !== userId || entry.state.kind !== "waiting") return false;
            const { approval, machine } = entry.state;
            entry.state = { kind: "deciding" };
            if (choice === "deny") {
              yield* finish(entry, declined());
              return true;
            }
            if (approval === "bind") {
              const bound = yield* repo.bind(userId, entry.conversationId, machine!.id);
              if (bound) yield* changed(userId);
              yield* advance(entry);
              return true;
            }
            if (approval === "network") {
              yield* grant(entry, choice);
              return true;
            }
            if (choice === "allow-rest" && (approval === "edit" || approval === "command"))
              blanket.add(`${entry.conversationId}\u0000${approval}`);
            const chat = yield* repo.chat(userId, entry.conversationId);
            if (!chat?.machineId) {
              yield* finish(
                entry,
                desktopFailure("That chat has no computer", "The chat's computer was removed."),
              );
              return true;
            }
            yield* send(entry, chat.machineId);
            return true;
          }),
        pending: (userId) =>
          Effect.sync(() =>
            [...entries.values()].flatMap((entry) =>
              entry.userId === userId && entry.state.kind === "waiting"
                ? [
                    {
                      callId: entry.callId,
                      conversationId: entry.conversationId,
                      name: entry.name,
                      args: entry.args,
                      approval: entry.state.approval,
                      ...(entry.state.machine ? { machine: entry.state.machine } : {}),
                    },
                  ]
                : [],
            ),
          ),
        result: (userId, machineId, callId, result) =>
          Effect.gen(function* () {
            const entry = entries.get(callId);
            if (
              !entry ||
              entry.userId !== userId ||
              entry.state.kind !== "sent" ||
              entry.state.machineId !== machineId
            )
              return false;
            return yield* finish(entry, result);
          }),
        pushPolicy,
      });
    }),
  );
}
