import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { ExternalCompletion } from "~/modules/tools/server/external-completion.ts";
import { mergeToolGroups } from "~/modules/tools/server/toolset.ts";
import { Tool } from "effect/unstable/ai";
import { prepareDesktopTools, requestNetworkAccessTool } from "./tools.ts";

const owner = {
  userId: "user",
  conversationId: "conversation",
  messageId: "message",
  generationId: "generation",
  executorId: "desktop",
};

const waitingHandler = Effect.gen(function* () {
  const ready = yield* Deferred.make<string | undefined>();
  const entered = yield* Deferred.make<void>();
  const completed = yield* Deferred.make<void>();
  const toolkit = yield* mergeToolGroups([
    prepareDesktopTools({
      commands: false,
      rowIdFor: (id) =>
        Effect.gen(function* () {
          expect(id).toBe("provider-call");
          yield* Deferred.succeed(entered, undefined);
          return yield* Deferred.await(ready);
        }),
    }),
  ]);
  const fiber = yield* Effect.forkChild(
    toolkit!.handle("list_folder", { path: "." }, "provider-call").pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.tap(() => Deferred.succeed(completed, undefined)),
    ),
    { startImmediately: true },
  );
  yield* Deferred.await(entered);
  return { ready, completed, fiber };
});

describe("desktop handler registration", () => {
  it("asks for a required host with an optional port and private network flag", () => {
    const schema = Tool.getJsonSchema(requestNetworkAccessTool);
    expect(schema).toMatchObject({
      properties: {
        host: { type: "string", minLength: 1, maxLength: 253 },
        port: { type: "integer", minimum: 1, maximum: 65_535 },
        privateNetwork: { type: "boolean" },
      },
      required: ["host"],
    });
  });

  it("offers network and path requests only when commands are ready", () => {
    const deps = { rowIdFor: () => Effect.succeed(undefined) };
    for (const name of ["request_network_access", "request_path_access"]) {
      expect(prepareDesktopTools({ ...deps, commands: false }).handlers).not.toHaveProperty(name);
      expect(prepareDesktopTools({ ...deps, commands: true }).handlers).toHaveProperty(name);
    }
  });

  it.effect("waits for registration and keeps an answer that arrived before readiness", () =>
    Effect.gen(function* () {
      const external = yield* ExternalCompletion;
      yield* external.track(owner, Effect.void);
      const handler = yield* waitingHandler;
      yield* TestClock.adjust("1 second");
      expect(yield* Deferred.isDone(handler.completed)).toBe(false);
      expect((yield* external.snapshot(owner.userId, owner.executorId)).calls).toEqual([]);

      yield* external.open("row", {
        ...owner,
        name: "list_folder",
        args: { path: "." },
        timeoutMs: 120_000,
      });
      const token = yield* external.claim("row", owner);
      expect(token).toBeTruthy();
      const reply = { v: 1, ok: true, summary: "Listed folders", detail: "site", truncated: false };
      expect(yield* external.completeClaim("row", owner, token!, reply)).toBe(true);
      yield* Deferred.succeed(handler.ready, "row");
      expect(yield* Fiber.join(handler.fiber)).toMatchObject([{ result: reply }]);
    }).pipe(Effect.scoped, Effect.provide(ExternalCompletion.layer)),
  );

  it.effect("interrupts a handler still waiting for registration without opening a call", () =>
    Effect.gen(function* () {
      const external = yield* ExternalCompletion;
      yield* external.track(owner, Effect.void);
      const handler = yield* waitingHandler;
      yield* Fiber.interrupt(handler.fiber);
      yield* Deferred.succeed(handler.ready, "row");
      expect(yield* Deferred.isDone(handler.completed)).toBe(false);
      expect(yield* external.pending("row")).toBe(false);
      expect((yield* external.snapshot(owner.userId, owner.executorId)).calls).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(ExternalCompletion.layer)),
  );
});
