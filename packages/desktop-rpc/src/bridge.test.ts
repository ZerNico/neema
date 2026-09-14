import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  makeDesktopClient,
  makeDesktopResponder,
  PROTOCOL_VERSION,
  readDesktopChannel,
  type DesktopChannel,
  type DesktopHandlers,
} from "./bridge.ts";
import { DesktopError } from "./schema.ts";

const unimplemented = (tag: string) => () =>
  Effect.fail(new DesktopError({ reason: "failed", message: `${tag} not part of this test` }));

const handlers = (overrides: Partial<DesktopHandlers>): DesktopHandlers => ({
  executionSession: unimplemented("executionSession"),
  cancelCall: unimplemented("cancelCall"),
  setWorkState: unimplemented("setWorkState"),
  readBinary: unimplemented("readBinary"),
  editFile: unimplemented("editFile"),
  movePath: unimplemented("movePath"),
  deletePath: unimplemented("deletePath"),
  findFiles: unimplemented("findFiles"),
  searchFiles: unimplemented("searchFiles"),
  folderStatus: unimplemented("folderStatus"),
  chooseFolder: unimplemented("chooseFolder"),
  detachFolder: unimplemented("detachFolder"),
  rebindFolder: unimplemented("rebindFolder"),
  listDirectory: unimplemented("listDirectory"),
  readFile: unimplemented("readFile"),
  writeFile: unimplemented("writeFile"),
  runCommand: unimplemented("runCommand"),
  revealPath: unimplemented("revealPath"),
  setUpSandbox: unimplemented("setUpSandbox"),
  ...overrides,
});

/** Stands in for contextBridge: the only thing crossing is what survives JSON. */
const connect = (implemented: Partial<DesktopHandlers>): DesktopChannel => {
  const respond = makeDesktopResponder(handlers(implemented));
  return {
    protocolVersion: PROTOCOL_VERSION,
    request: async (tag, payload) => {
      const wire = JSON.parse(JSON.stringify({ tag, payload })) as {
        tag: string;
        payload: unknown;
      };
      const reply = await Effect.runPromise(respond(wire.tag, wire.payload));
      return JSON.parse(JSON.stringify(reply)) as typeof reply;
    },
  };
};

describe("the desktop channel", () => {
  it("round-trips a decoded result through the declared schemas", async () => {
    const client = makeDesktopClient(
      connect({
        readFile: ({ path }) => Effect.succeed({ path, text: "hello", truncated: false }),
      }),
    );

    const contents = await Effect.runPromise(
      client.readFile({ conversationId: "c1", path: "notes.md", callId: "c" }),
    );

    expect(contents).toEqual({ path: "notes.md", text: "hello", truncated: false });
  });

  it("carries a refusal across as a typed failure, not a thrown error", async () => {
    const client = makeDesktopClient(
      connect({
        readFile: () =>
          Effect.fail(
            new DesktopError({
              reason: "outside-folder",
              message: "That file is outside the folder.",
            }),
          ),
      }),
    );

    const outcome = await Effect.runPromise(
      Effect.result(client.readFile({ conversationId: "c1", path: "../secrets", callId: "c" })),
    );

    expect(outcome._tag).toBe("Failure");
    if (outcome._tag !== "Failure") return;
    expect(outcome.failure).toBeInstanceOf(DesktopError);
    expect(outcome.failure.reason).toBe("outside-folder");
    expect(outcome.failure.message).toBe("That file is outside the folder.");
  });

  it("refuses a procedure the shell does not know rather than hanging", async () => {
    const respond = makeDesktopResponder(handlers({}));

    const reply = await Effect.runPromise(respond("deleteEverything", {}));

    expect(reply.ok).toBe(false);
  });

  it("turns a malformed payload into a refusal before any handler runs", async () => {
    let ran = false;
    const respond = makeDesktopResponder(
      handlers({
        readFile: () => {
          ran = true;
          return Effect.succeed({ path: "x", text: "", truncated: false });
        },
      }),
    );

    const reply = await Effect.runPromise(respond("readFile", { conversationId: 42 }));

    expect(reply.ok).toBe(false);
    expect(ran).toBe(false);
  });

  it("carries call ids and lifecycle requests through the schema-derived client", async () => {
    let receivedId: string | undefined;
    let work = { active: 0, needsApproval: 0 };
    const client = makeDesktopClient(
      connect({
        executionSession: () => Effect.succeed({ id: "session" }),
        cancelCall: ({ callId }) => Effect.succeed(callId === "call"),
        setWorkState: (state) =>
          Effect.sync(() => {
            work = state;
          }),
        readFile: ({ callId, path }) =>
          Effect.sync(() => {
            receivedId = callId;
            return { path, text: "hello", truncated: false };
          }),
      }),
    );
    expect(await Effect.runPromise(client.executionSession(undefined))).toEqual({ id: "session" });
    expect(await Effect.runPromise(client.cancelCall({ callId: "call" }))).toBe(true);
    await Effect.runPromise(client.setWorkState({ active: 2, needsApproval: 1 }));
    expect(work).toEqual({ active: 2, needsApproval: 1 });
    await Effect.runPromise(
      client.readFile({ callId: "call", conversationId: "c", path: "work/file" }),
    );
    expect(receivedId).toBe("call");
  });

  it("round-trips a reveal, which answers with nothing at all", async () => {
    const asked: { path: string; mode: string }[] = [];
    const client = makeDesktopClient(
      connect({
        revealPath: ({ path, mode }) =>
          Effect.sync(() => {
            asked.push({ path, mode });
          }),
      }),
    );

    // Void has no JSON form, so the empty success has to survive the channel
    // rather than decode as a missing value.
    expect(
      await Effect.runPromise(
        client.revealPath({ conversationId: "c", path: "site/logo.png", mode: "reveal" }),
      ),
    ).toBeUndefined();
    expect(asked).toEqual([{ path: "site/logo.png", mode: "reveal" }]);

    const outcome = await Effect.runPromise(
      Effect.result(
        // `mode` is closed, so a site asking for something else never reaches
        // the handler that would hand a path to the operating system.
        client.revealPath({
          conversationId: "c",
          path: "site/logo.png",
          mode: "execute" as "open",
        }),
      ),
    );
    expect(outcome._tag).toBe("Failure");
    expect(asked).toHaveLength(1);
  });

  it("ignores a shell speaking a different protocol version", () => {
    const globals = globalThis as Record<string, unknown>;
    globals.__chatDesktop = { protocolVersion: PROTOCOL_VERSION + 1, request: () => {} };
    expect(readDesktopChannel()).toBeNull();

    globals.__chatDesktop = { protocolVersion: PROTOCOL_VERSION, request: () => {} };
    expect(readDesktopChannel()).not.toBeNull();

    delete globals.__chatDesktop;
    expect(readDesktopChannel()).toBeNull();
  });
});
