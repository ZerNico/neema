import { Clock, Context, Duration, Effect, Layer, Scope } from "effect";
import type { ToolResult } from "@chat/desktop-rpc";
import { canonicalHost } from "@chat/egress-proxy";
import { desktopFailure, type DesktopToolResult } from "~/modules/desktop/tool-schema.ts";
import { ExternalCompletion } from "~/modules/tools/server/external-completion.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { MachineHub } from "./hub.ts";
import { sentFilePaths } from "./files.ts";
import { ComputerRepo } from "./repo.ts";
import { CommandReviewer } from "./review.ts";

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
  /** Why the reviewer asked, under "ask when risky", in the person's language. */
  readonly reason?: string;
}

interface Entry {
  readonly userId: string;
  readonly conversationId: string;
  readonly callId: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly deadlineAt: number;
  /** The session the message came from; which machine that is, the hub says (`senderOf`). */
  readonly senderSession: string | undefined;
  /** The answer's model, which reviews the call when the admin chose no reviewer. */
  readonly modelId: string | undefined;
  /** The call's own scope: what runs for it ends with it. */
  readonly scope: Scope.Scope;
  /** It already waited once for a machine to come back, so an absent one is now an answer. */
  waitedForMachine?: true;
  state:
    | { readonly kind: "deciding" }
    | {
        readonly kind: "waiting";
        readonly approval: ComputerApproval;
        readonly machine?: { id: string; name: string };
        readonly reason?: string;
      }
    | { readonly kind: "sent"; readonly machineId: string }
    /**
     * Held until the machine has its environment, or is back (null: any of the person's), so the
     * model is not answered meanwhile.
     */
    | { readonly kind: "preparing"; readonly machineId: string | null }
    | { readonly kind: "done" };
}

/** How long before a call's deadline a held call is answered, so the model hears why. */
const DEADLINE_MARGIN_MS = 5_000;
/**
 * How long a call waits for a machine that is likely reconnecting: the desktop's longest backoff.
 * Likely means seen in the last two minutes, or the server started within the last one, since a
 * restart drops every machine's stream at once and may not record when.
 */
const RECONNECT_GRACE_MS = 30_000;
const RECENTLY_SEEN_MS = 120_000;
const JUST_STARTED_MS = 60_000;

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
    case "write_file":
    case "edit_file":
      return "edit";
    // Into the workspace under a fresh name nothing is overwritten; to a chosen path it is a write.
    case "copy_to_computer":
      return typeof args.path === "string" && args.path ? "edit" : null;
    case "delete_files":
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
      /** From the request's session, never its body. */
      senderSession?: string | undefined;
      /** The answer's model; see `Entry.modelId`. */
      modelId?: string | undefined;
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
    /** A machine reported a new status: calls held for it go on. */
    machineChanged(userId: string, machineId: string): Effect.Effect<void>;
    /**
     * A machine's stream opened. Events queued for its old stream died with it, so it hears which
     * calls are still wanted and gets each again; it answers a call it already has from that.
     */
    machineConnected(userId: string, machineId: string): Effect.Effect<void>;
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
      const reviewer = yield* CommandReviewer;
      const bus = yield* SyncBus;
      const entries = new Map<string, Entry>();
      const startedAt = yield* Clock.currentTimeMillis;
      /** Whether a machine away now is likely on its way back; see `RECONNECT_GRACE_MS`. */
      const likelyBack = (entry: Entry, lastSeen: ReadonlyArray<Date>) =>
        Effect.map(
          Clock.currentTimeMillis,
          (now) =>
            !entry.waitedForMachine &&
            (now - startedAt < JUST_STARTED_MS ||
              lastSeen.some((seen) => now - seen.getTime() < RECENTLY_SEEN_MS)),
        );
      /** Kinds a person allowed for the rest of a chat, until the server restarts. */
      const blanket = new Set<string>();

      // Clients see only calls waiting for a person (`pending`), so they hear a change only when
      // one starts or stops waiting: every open client refetches on each.
      const changed = (userId: string) => bus.publish(userId, { type: "computer.changed" });
      /** Read through a call so TypeScript does not keep a narrowing an await may have broken. */
      const ended = (entry: Entry) => entry.state.kind === "done";

      const finish = (entry: Entry, result: DesktopToolResult) =>
        Effect.gen(function* () {
          if (entry.state.kind === "done") return false;
          const waited = entry.state.kind === "waiting";
          entry.state = { kind: "done" };
          const accepted = yield* external.complete(entry.callId, result);
          if (waited) yield* changed(entry.userId);
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
        extra: { machine?: { id: string; name: string }; reason?: string | null } = {},
      ) =>
        Effect.gen(function* () {
          if (ended(entry)) return;
          entry.state = {
            kind: "waiting",
            approval,
            ...(extra.machine ? { machine: extra.machine } : {}),
            ...(extra.reason ? { reason: extra.reason } : {}),
          };
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
          // Asked now rather than at open: the machine's stream may have reconnected since.
          const sender = yield* hub.machineOfSession(entry.userId, entry.senderSession);
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
            // A machine still getting ready can take the chat; the call then waits for it.
            const usable = (yield* hub.online(entry.userId)).filter(
              (presence) => presence.hello.computer.status !== "unavailable",
            );
            const candidate =
              usable.find((presence) => presence.machineId === sender) ??
              usable.find((presence) => presence.hello.computer.status === "ready") ??
              usable[0];
            if (!candidate) {
              const known = yield* repo.machines(entry.userId);
              if (
                known.length > 0 &&
                (yield* likelyBack(
                  entry,
                  known.map((machine) => machine.lastSeenAt),
                ))
              ) {
                yield* hold(entry, null, "reconnecting");
                return;
              }
              yield* finish(
                entry,
                desktopFailure(
                  "No computer is connected",
                  "This chat has no computer yet and none of the user's desktop apps is online and ready. Tell the user to open the desktop app.",
                ),
              );
              return;
            }
            yield* wait(entry, "bind", {
              machine: { id: candidate.machineId, name: candidate.hello.name },
            });
            return;
          }
          const presence = yield* hub.presence(entry.userId, chat.machineId);
          if (!presence) {
            const machine = yield* repo.machine(entry.userId, chat.machineId);
            if (yield* likelyBack(entry, machine ? [machine.lastSeenAt] : [])) {
              yield* hold(entry, chat.machineId, "reconnecting");
              return;
            }
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
          if (status.status === "unavailable") {
            yield* finish(
              entry,
              desktopFailure(
                `${presence.hello.name} is not ready`,
                `${presence.hello.name} cannot run this chat's computer: ${status.reason}`,
              ),
            );
            return;
          }
          if (status.status === "preparing") {
            yield* hold(entry, chat.machineId, "preparing");
            return;
          }
          if (sender !== chat.machineId && !presence.hello.remote) {
            yield* finish(
              entry,
              desktopFailure(
                `${presence.hello.name} does not allow remote use`,
                `This chat's computer only runs calls sent from ${presence.hello.name} itself. Tell the user to continue there, or to allow remote control in its settings.`,
              ),
            );
            return;
          }
          if (AT_MACHINE.has(entry.name) && sender !== chat.machineId) {
            yield* finish(
              entry,
              desktopFailure(
                `Only at ${presence.hello.name}`,
                `This asks the user at ${presence.hello.name} itself, and this message came from another device. Ask them to attach the folder or allow the SSH agent there.`,
              ),
            );
            return;
          }
          const changes = approval === "edit" || approval === "command";
          const allowedHere = blanket.has(`${entry.conversationId}\u0000${approval}`);
          if (approval === "delete" || (changes && chat.permissionLevel === "ask" && !allowedHere)) {
            yield* wait(entry, approval);
            return;
          }
          if (changes && chat.permissionLevel === "review" && !allowedHere) {
            const verdict = yield* reviewer.review({
              userId: entry.userId,
              conversationId: entry.conversationId,
              modelId: entry.modelId,
              name: entry.name,
              args: entry.args,
              folders: chat.folders,
            });
            // The review takes seconds; Stop may have ended the call meanwhile.
            if (ended(entry)) return;
            if (!verdict.run) {
              yield* wait(entry, approval, { reason: verdict.reason });
              return;
            }
          }
          yield* send(entry, chat.machineId);
        });

      /**
       * Waits for the machine to finish its environment, or to come back, instead of answering
       * the model with a computer it might try to work around. `machineChanged` and
       * `machineConnected` resume the call. A reconnect is waited for briefly, then the call is
       * decided again without the wait; a download until just before the deadline, when the
       * model hears how far it got.
       */
      const hold = (entry: Entry, machineId: string | null, why: "preparing" | "reconnecting") =>
        Effect.gen(function* () {
          if (ended(entry)) return;
          const already = entry.state.kind === "preparing";
          entry.state = { kind: "preparing", machineId };
          if (already) return;
          const now = yield* Clock.currentTimeMillis;
          const untilDeadline = entry.deadlineAt - now - DEADLINE_MARGIN_MS;
          yield* Effect.forkIn(
            Effect.gen(function* () {
              yield* Effect.sleep(
                Duration.millis(
                  Math.max(
                    0,
                    why === "reconnecting"
                      ? Math.min(untilDeadline, RECONNECT_GRACE_MS)
                      : untilDeadline,
                  ),
                ),
              );
              if (entry.state.kind !== "preparing") return;
              if (why === "reconnecting") {
                entry.waitedForMachine = true;
                entry.state = { kind: "deciding" };
                yield* advance(entry);
                return;
              }
              if (machineId === null) return;
              const presence = yield* hub.presence(entry.userId, machineId);
              const progress =
                presence?.hello.computer.status === "preparing"
                  ? ` (${Math.round(presence.hello.computer.progress * 100)}%)`
                  : "";
              const name = presence?.hello.name ?? "The computer";
              yield* finish(
                entry,
                desktopFailure(
                  `${name} is still getting ready`,
                  `${name} is still downloading its environment${progress}, so nothing ran. Tell the user, and try again in a few minutes.`,
                ),
              );
            }),
            entry.scope,
          );
        });

      // Every await before a state change may let Stop close the call's scope, whose finalizer
      // marks it done. A call that ended meanwhile is never sent, or is cancelled if it was.
      const send = (entry: Entry, machineId: string) =>
        Effect.gen(function* () {
          const files = yield* repo.sentFiles(entry.userId, entry.conversationId);
          if (ended(entry)) return;
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
          if (ended(entry)) {
            yield* hub.send(entry.userId, machineId, { type: "cancel", callId: entry.callId });
            return;
          }
          entry.state = { kind: "sent", machineId };
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

      const advanceHeld = (userId: string, machineId: string) =>
        Effect.forEach(
          [...entries.values()].filter(
            (entry) =>
              entry.userId === userId &&
              entry.state.kind === "preparing" &&
              (entry.state.machineId === machineId || entry.state.machineId === null),
          ),
          advance,
          { discard: true },
        );

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
              senderSession: input.senderSession,
              modelId: input.modelId,
              scope: yield* Effect.scope,
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
                if (state.kind === "waiting") yield* changed(entry.userId);
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
            yield* changed(userId);
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
                      ...(entry.state.reason ? { reason: entry.state.reason } : {}),
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
        machineConnected: (userId, machineId) =>
          Effect.gen(function* () {
            const sent = [...entries.values()].filter(
              (entry) =>
                entry.userId === userId &&
                entry.state.kind === "sent" &&
                entry.state.machineId === machineId,
            );
            yield* hub.send(userId, machineId, {
              type: "running",
              callIds: sent.map((entry) => entry.callId),
            });
            yield* Effect.forEach(sent, (entry) => send(entry, machineId), { discard: true });
            yield* advanceHeld(userId, machineId);
          }),
        machineChanged: (userId, machineId) => advanceHeld(userId, machineId),
      });
    }),
  );
}
