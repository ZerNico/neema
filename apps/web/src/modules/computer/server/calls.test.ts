import { describe, expect, it } from "@effect/vitest";
import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Scope,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import type { MachineEvent, MachineHello } from "@chat/desktop-rpc";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { ExternalCompletion } from "~/modules/tools/server/external-completion.ts";
import { ComputerCalls } from "./calls.ts";
import { sentFilePaths } from "./files.ts";
import { MachineHub } from "./hub.ts";
import { ComputerRepo, type ChatComputer } from "./repo.ts";

const USER = "u";
const CHAT = "c";

/** An in-memory stand-in for the database side, holding one chat and its grants. */
const fakeRepo = (
  initial: Partial<ChatComputer> = {},
  /** Holds `sentFiles` until released: the database read right before a call is sent. */
  gate?: Deferred.Deferred<void>,
) => {
  const chat: { -readonly [K in keyof ChatComputer]: ChatComputer[K] } = {
    conversationId: CHAT,
    machineId: null,
    folders: [],
    permissionLevel: "ask",
    ...initial,
  };
  const grants: Array<{
    conversationId: string | null;
    host: string;
    port: number;
    privateNetwork: boolean;
  }> = [];
  const layer = Layer.succeed(
    ComputerRepo,
    ComputerRepo.of({
      saveMachine: () => Effect.void,
      touchMachine: () => Effect.void,
      machine: (_userId, id) =>
        Effect.succeed({
          id,
          name: "Laptop",
          platform: "darwin" as const,
          lastSeenAt: new Date(0),
        }),
      machines: () => Effect.succeed([]),
      forgetMachine: () => Effect.void,
      gone: () => Effect.succeed([]),
      chat: () => Effect.succeed({ ...chat }),
      bind: (_userId, _id, machineId) =>
        Effect.sync(() => {
          if (chat.machineId) return false;
          chat.machineId = machineId;
          return true;
        }),
      rebind: () => Effect.succeed(true),
      setFolders: () => Effect.succeed(true),
      setPermissionLevel: () => Effect.succeed(true),
      grants: () => Effect.succeed(grants.map((grant, index) => ({ id: `g${index}`, ...grant }))),
      addGrant: (_userId, grant) => Effect.sync(() => void grants.push(grant)),
      removeGrant: () => Effect.succeed(true),
      sentFiles: () =>
        Effect.as(gate ? Deferred.await(gate) : Effect.void, [{ id: "a1", name: "data.csv" }]),
    }),
  );
  return { chat, grants, layer };
};

/** What every open client of the person would have been told to refetch. */
const published: string[] = [];
const bus = Layer.succeed(
  SyncBus,
  SyncBus.of({
    publish: (_userId, event) => Effect.sync(() => void published.push(event.type)),
    publishGlobal: () => Effect.void,
    subscribe: () => Stream.empty,
    signals: Stream.empty,
  }),
);

const hello = (machineId: string, overrides: Partial<MachineHello> = {}): MachineHello => ({
  machineId,
  name: "Laptop",
  platform: "darwin",
  computer: { status: "ready" },
  remote: true,
  ...overrides,
});

const owner = {
  userId: USER,
  conversationId: CHAT,
  messageId: "m",
  generationId: "g",
  executorId: "computer",
};

/** One call through the whole path, its wait parked like a tool handler's. */
const setup = (repo: ReturnType<typeof fakeRepo>) =>
  Effect.gen(function* () {
    const external = yield* ExternalCompletion;
    const hub = yield* MachineHub;
    const calls = yield* ComputerCalls;
    yield* external.track(owner, Effect.void);
    const open = (
      callId: string,
      name: string,
      args: Record<string, unknown> = {},
      sender?: string,
    ) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        yield* external
          .open(callId, { ...owner, name, args, timeoutMs: 60_000 })
          .pipe(Scope.provide(scope));
        yield* calls
          .open({
            userId: USER,
            conversationId: CHAT,
            callId,
            name,
            args,
            timeoutMs: 60_000,
            // A machine's own page shares its session; see `connect` below.
            senderSession: sender === undefined ? undefined : `session:${sender}`,
          })
          .pipe(Scope.provide(scope));
        const waiting = yield* Effect.forkChild(
          external.await(callId, { timeout: Duration.seconds(60), onTimeout: () => "timed out" }),
          { startImmediately: true },
        );
        return { scope, waiting };
      });
    const connect = (machineId: string, overrides: Partial<MachineHello> = {}) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const events = yield* hub
          .connect(USER, hello(machineId, overrides), `session:${machineId}`)
          .pipe(Scope.provide(scope));
        const queue = yield* Queue.unbounded<MachineEvent>();
        yield* Effect.forkChild(Stream.runForEach(events, (event) => Queue.offer(queue, event)));
        return { scope, queue };
      });
    return { calls, open, connect, repo, hub };
  }).pipe(
    Effect.provide(
      ComputerCalls.layer.pipe(
        Layer.provideMerge(MachineHub.layer),
        Layer.provideMerge(ExternalCompletion.layer),
        Layer.provideMerge(repo.layer),
        Layer.provideMerge(bus),
      ),
    ),
  );

const nextCall = (queue: Queue.Queue<MachineEvent>) =>
  Effect.gen(function* () {
    for (;;) {
      const event = yield* Queue.take(queue);
      if (event.type === "call" || event.type === "cancel") return event;
    }
  });

describe("ComputerCalls", () => {
  it.effect("an unbound chat asks which machine, then runs a read there", () =>
    Effect.gen(function* () {
      const repo = fakeRepo();
      const { calls, open, connect } = yield* setup(repo);
      const laptop = yield* connect("laptop");
      const { waiting } = yield* open("call-1", "list_folder", { path: "." }, "laptop");
      const pending = yield* calls.pending(USER);
      expect(pending).toEqual([
        expect.objectContaining({
          callId: "call-1",
          approval: "bind",
          machine: { id: "laptop", name: "Laptop" },
        }),
      ]);
      expect(yield* calls.decide(USER, "call-1", "allow")).toBe(true);
      expect(repo.chat.machineId).toBe("laptop");
      const sent = yield* nextCall(laptop.queue);
      expect(sent).toMatchObject({ type: "call", callId: "call-1", name: "list_folder" });
      expect(sent.type === "call" && sent.attachments).toEqual([
        { id: "a1", path: "/workspace/data.csv" },
      ]);
      const result = {
        v: 1 as const,
        ok: true,
        summary: "Listed .",
        detail: "/workspace",
        truncated: false,
      };
      expect(yield* calls.result(USER, "someone-else", "call-1", result)).toBe(false);
      expect(yield* calls.result(USER, "laptop", "call-1", result)).toBe(true);
      expect(yield* Fiber.join(waiting)).toEqual(result);
    }),
  );

  it.effect("a bound machine long offline is answered for at once", () =>
    Effect.gen(function* () {
      const { open } = yield* setup(fakeRepo({ machineId: "laptop" }));
      // Past the server's first minute, and the machine was last seen long ago.
      yield* TestClock.adjust(Duration.minutes(2));
      const { waiting } = yield* open("call-1", "run_command", { command: "ls" });
      expect(yield* Fiber.join(waiting)).toMatchObject({ ok: false, summary: "Laptop is offline" });
    }),
  );

  it.effect("just after a restart a call waits for its machine to reconnect, and runs then", () =>
    Effect.gen(function* () {
      const { calls, open, connect } = yield* setup(
        fakeRepo({ machineId: "laptop", permissionLevel: "allow" }),
      );
      yield* open("call-1", "run_command", { command: "ls" }, "laptop");
      yield* TestClock.adjust(Duration.seconds(10));
      const laptop = yield* connect("laptop");
      yield* calls.machineConnected(USER, "laptop");
      expect(yield* nextCall(laptop.queue)).toMatchObject({ type: "call", callId: "call-1" });
    }),
  );

  it.effect("a machine that does not come back is answered for after the grace", () =>
    Effect.gen(function* () {
      const { open } = yield* setup(fakeRepo({ machineId: "laptop" }));
      const { waiting } = yield* open("call-1", "run_command", { command: "ls" });
      yield* TestClock.adjust(Duration.seconds(30));
      expect(yield* Fiber.join(waiting)).toMatchObject({ ok: false, summary: "Laptop is offline" });
    }),
  );

  it.effect("an unbound chat binds to its sender while that is still getting ready", () =>
    Effect.gen(function* () {
      const { calls, open, connect } = yield* setup(fakeRepo());
      yield* connect("laptop", { computer: { status: "preparing", progress: 0.4 } });
      yield* open("call-1", "list_folder", { path: "." }, "laptop");
      expect(yield* calls.pending(USER)).toEqual([
        expect.objectContaining({ approval: "bind", machine: { id: "laptop", name: "Laptop" } }),
      ]);
    }),
  );

  it.effect("ask asks before a command; allow-rest stops asking for the rest of the chat", () =>
    Effect.gen(function* () {
      const { calls, open, connect } = yield* setup(fakeRepo({ machineId: "laptop" }));
      const laptop = yield* connect("laptop");
      yield* open("call-1", "run_command", { command: "ls" }, "laptop");
      expect((yield* calls.pending(USER)).map((call) => call.approval)).toEqual(["command"]);
      yield* calls.decide(USER, "call-1", "allow-rest");
      expect(yield* nextCall(laptop.queue)).toMatchObject({ callId: "call-1" });
      yield* open("call-2", "run_command", { command: "pwd" }, "laptop");
      expect(yield* calls.pending(USER)).toEqual([]);
      expect(yield* nextCall(laptop.queue)).toMatchObject({ callId: "call-2" });
    }),
  );

  it.effect("deletes always ask, even when the chat allows everything", () =>
    Effect.gen(function* () {
      const { calls, open, connect } = yield* setup(
        fakeRepo({ machineId: "laptop", permissionLevel: "allow" }),
      );
      yield* connect("laptop");
      yield* open("call-1", "delete_local_file", { paths: ["/workspace/a"] }, "laptop");
      expect((yield* calls.pending(USER)).map((call) => call.approval)).toEqual(["delete"]);
    }),
  );

  it.effect("a denial answers the model without reaching the machine", () =>
    Effect.gen(function* () {
      const { calls, open, connect } = yield* setup(fakeRepo({ machineId: "laptop" }));
      const laptop = yield* connect("laptop");
      const { waiting } = yield* open(
        "call-1",
        "write_local_file",
        { path: "/workspace/a", text: "x" },
        "laptop",
      );
      yield* calls.decide(USER, "call-1", "deny");
      expect(yield* Fiber.join(waiting)).toMatchObject({ ok: false, summary: "You declined that" });
      expect(
        Option.isNone(
          yield* Queue.poll(laptop.queue).pipe(
            Effect.map((event) =>
              event._tag === "Some" && event.value.type === "call" ? event : Option.none(),
            ),
          ),
        ),
      ).toBe(true);
    }),
  );

  it.effect("approving a destination stores the grant and pushes it to the machines", () =>
    Effect.gen(function* () {
      const repo = fakeRepo({ machineId: "laptop" });
      const { calls, open, connect } = yield* setup(repo);
      const laptop = yield* connect("laptop");
      const { waiting } = yield* open("call-1", "request_network_access", {
        host: "Example.com",
        port: 22,
      });
      yield* calls.decide(USER, "call-1", "allow-everywhere");
      expect(repo.grants).toEqual([
        { conversationId: null, host: "example.com", port: 22, privateNetwork: false },
      ]);
      expect(yield* Fiber.join(waiting)).toMatchObject({
        ok: true,
        summary: "Allowed example.com:22 in every chat",
      });
      let grants: MachineEvent | undefined;
      while (grants?.type !== "grants" || grants.grants.length === 0)
        grants = yield* Queue.take(laptop.queue);
      expect(grants.grants).toEqual([expect.objectContaining({ host: "example.com", port: 22 })]);
    }),
  );

  it.effect("a machine that refuses remote use only runs calls it sent itself", () =>
    Effect.gen(function* () {
      const { open, connect } = yield* setup(
        fakeRepo({ machineId: "laptop", permissionLevel: "allow" }),
      );
      yield* connect("laptop", { remote: false });
      const { waiting } = yield* open("call-1", "list_folder", { path: "." }, "phone-browser");
      expect(yield* Fiber.join(waiting)).toMatchObject({
        ok: false,
        summary: "Laptop does not allow remote use",
      });
    }),
  );

  it.effect("a page is the machine only through the machine's own session", () =>
    Effect.gen(function* () {
      const { open, connect } = yield* setup(
        fakeRepo({ machineId: "laptop", permissionLevel: "allow" }),
      );
      yield* connect("laptop", { remote: false });
      // Another session of the person, whatever machine its request named, is remote.
      const other = yield* open("call-1", "list_folder", { path: "." }, "browser-tab");
      expect(yield* Fiber.join(other.waiting)).toMatchObject({
        summary: "Laptop does not allow remote use",
      });
      const dialog = yield* open("call-2", "request_folder", {}, "browser-tab");
      expect(yield* Fiber.join(dialog.waiting)).toMatchObject({ ok: false });
    }),
  );

  it.effect("a folder or the SSH agent is only asked for at the machine itself", () =>
    Effect.gen(function* () {
      const { calls, open, connect } = yield* setup(fakeRepo({ machineId: "laptop" }));
      const laptop = yield* connect("laptop");
      const remote = yield* open("call-1", "request_folder", {}, "phone");
      expect(yield* Fiber.join(remote.waiting)).toMatchObject({
        ok: false,
        summary: "Only at Laptop",
      });
      yield* open("call-2", "request_ssh_agent", {}, "laptop");
      expect(yield* calls.pending(USER)).toEqual([]);
      expect(yield* nextCall(laptop.queue)).toMatchObject({
        callId: "call-2",
        name: "request_ssh_agent",
      });
    }),
  );

  it.effect("a call waits while the machine downloads its environment, then runs", () =>
    Effect.gen(function* () {
      const { calls, open, connect, hub } = yield* setup(
        fakeRepo({ machineId: "laptop", permissionLevel: "allow" }),
      );
      const laptop = yield* connect("laptop", { computer: { status: "preparing", progress: 0.4 } });
      yield* open("call-1", "run_command", { command: "ls" }, "laptop");
      yield* Effect.yieldNow;
      expect(Option.isNone(yield* Queue.poll(laptop.queue))).toBe(true);
      yield* hub.update(USER, hello("laptop"));
      yield* calls.machineChanged(USER, "laptop");
      expect(yield* nextCall(laptop.queue)).toMatchObject({ type: "call", callId: "call-1" });
    }),
  );

  it.effect("a call still waiting near its deadline hears how far the download got", () =>
    Effect.gen(function* () {
      const { open, connect } = yield* setup(
        fakeRepo({ machineId: "laptop", permissionLevel: "allow" }),
      );
      yield* connect("laptop", { computer: { status: "preparing", progress: 0.64 } });
      const { waiting } = yield* open("call-1", "list_folder", { path: "." }, "laptop");
      yield* TestClock.adjust(Duration.seconds(56));
      expect(yield* Fiber.join(waiting)).toMatchObject({
        ok: false,
        summary: "Laptop is still getting ready",
        detail: expect.stringContaining("(64%)"),
      });
    }),
  );

  it.effect("a Stop while an approval is being carried out never lets the call run", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const { calls, open, connect } = yield* setup(fakeRepo({ machineId: "laptop" }, gate));
      const laptop = yield* connect("laptop");
      const { scope } = yield* open("call-1", "run_command", { command: "rm -rf build" }, "laptop");
      const deciding = yield* Effect.forkChild(calls.decide(USER, "call-1", "allow"), {
        startImmediately: true,
      });
      yield* Scope.close(scope, Exit.void);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(deciding);
      // Events arrive in order: had call-1 reached the machine, it would come first.
      yield* open("call-2", "list_folder", { path: "." }, "laptop");
      expect(yield* nextCall(laptop.queue)).toMatchObject({ type: "call", callId: "call-2" });
    }),
  );

  it.effect("a reconnecting machine hears which calls are wanted, and gets each again", () =>
    Effect.gen(function* () {
      const { calls, open, connect } = yield* setup(
        fakeRepo({ machineId: "laptop", permissionLevel: "allow" }),
      );
      const before = yield* connect("laptop");
      yield* open("call-1", "run_command", { command: "make" }, "laptop");
      expect(yield* nextCall(before.queue)).toMatchObject({ callId: "call-1" });
      // The old stream died with whatever it had not delivered yet.
      const after = yield* connect("laptop");
      yield* calls.machineConnected(USER, "laptop");
      expect(yield* Queue.take(after.queue)).toEqual({ type: "running", callIds: ["call-1"] });
      expect(yield* nextCall(after.queue)).toMatchObject({ type: "call", callId: "call-1" });
    }),
  );

  it.effect(
    "clients hear of a call only when it waits for a person, and of downloads in steps",
    () =>
      Effect.gen(function* () {
        const { calls, open, connect, hub } = yield* setup(fakeRepo({ machineId: "laptop" }));
        const laptop = yield* connect("laptop", { computer: { status: "preparing", progress: 0 } });
        const told = () => published.length;
        let before = told();
        for (let percent = 1; percent <= 12; percent += 1)
          yield* hub.update(
            USER,
            hello("laptop", { computer: { status: "preparing", progress: percent / 100 } }),
          );
        expect(told() - before).toBe(2);
        yield* hub.update(USER, hello("laptop"));
        before = told();
        yield* open("call-1", "list_folder", { path: "." }, "laptop");
        yield* calls.result(USER, "laptop", "call-1", {
          v: 1,
          ok: true,
          summary: "Listed",
          detail: "",
          truncated: false,
        });
        expect(told() - before).toBe(0);
        yield* open("call-2", "run_command", { command: "ls" }, "laptop");
        yield* calls.decide(USER, "call-2", "allow");
        expect(yield* nextCall(laptop.queue)).toMatchObject({ callId: "call-1" });
        expect(told() - before).toBe(2);
      }),
  );

  it.effect("ending the call's scope cancels it on the machine", () =>
    Effect.gen(function* () {
      const { open, connect } = yield* setup(
        fakeRepo({ machineId: "laptop", permissionLevel: "allow" }),
      );
      const laptop = yield* connect("laptop");
      const { scope } = yield* open("call-1", "run_command", { command: "sleep 100" }, "laptop");
      expect(yield* nextCall(laptop.queue)).toMatchObject({ type: "call" });
      yield* Scope.close(scope, Exit.void);
      expect(yield* nextCall(laptop.queue)).toEqual({ type: "cancel", callId: "call-1" });
    }),
  );
});

describe("sentFilePaths", () => {
  it("names each file by its own name, numbering later ones that collide", () => {
    expect(
      sentFilePaths([
        { id: "1", name: "data.csv" },
        { id: "2", name: "data.csv" },
        { id: "3", name: "../../etc/passwd" },
        { id: "4", name: "" },
      ]),
    ).toEqual([
      { id: "1", path: "/workspace/data.csv" },
      { id: "2", path: "/workspace/data (2).csv" },
      { id: "3", path: "/workspace/passwd" },
      { id: "4", path: "/workspace/file" },
    ]);
  });
});
