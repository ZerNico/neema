import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeExecutions } from "./executions.ts";
import { refusalReply } from "@chat/desktop-rpc";

const payload = { callId: "call", conversationId: "chat", fileName: "page.pdf" };
const reply = { ok: true, value: { text: "hello" } } as const;

describe("main-process executions", () => {
  it("joins a reloaded renderer onto the call its predecessor started", async () => {
    const finish = Promise.withResolvers<typeof reply>();
    const started = Promise.withResolvers<void>();
    const run = vi.fn(() => {
      started.resolve();
      return finish.promise;
    });
    const executions = makeExecutions(run);
    const first = executions.request("saveToWorkspace", payload);
    await started.promise;
    const reloaded = executions.request("saveToWorkspace", { ...payload });
    expect(first).toBe(reloaded);
    finish.resolve(reply);
    expect(await first).toEqual(reply);
    expect(run).toHaveBeenCalledTimes(1);
    await executions.dispose();
  });

  it("answers a replayed save from its retained result, and runs anything else as asked", async () => {
    const run = vi.fn(async () => reply);
    const executions = makeExecutions(run);
    expect(await executions.request("saveToWorkspace", payload)).toEqual(reply);
    expect(await executions.request("saveToWorkspace", payload)).toEqual(reply);
    expect(run).toHaveBeenCalledTimes(1);
    expect(await executions.request("readFile", payload)).toEqual(reply);
    expect(await executions.request("readFile", payload)).toEqual(reply);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("retains a failed save rather than retrying it", async () => {
    const failure = refusalReply("not-found", "Missing.");
    const run = vi.fn(async () => failure);
    const executions = makeExecutions(run);
    expect(await executions.request("saveToWorkspace", payload)).toEqual(failure);
    expect(await executions.request("saveToWorkspace", payload)).toEqual(failure);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("refuses a request that arrives after its cancellation", async () => {
    const run = vi.fn(async () => reply);
    const executions = makeExecutions(run);
    expect(executions.cancelCall("call")).toBe(false);
    expect(await executions.request("saveToWorkspace", payload)).toMatchObject({ ok: false });
    expect(run).not.toHaveBeenCalled();
  });

  it("forgets results and cancellations once the server would no longer accept them", async () => {
    let now = 0;
    const run = vi.fn(async () => reply);
    const executions = makeExecutions(run, { now: () => now, retentionMs: 10 });
    await executions.request("saveToWorkspace", payload);
    executions.cancelCall("stopped");
    now = 5;
    expect(await executions.request("saveToWorkspace", payload)).toEqual(reply);
    expect(run).toHaveBeenCalledTimes(1);
    now = 11;
    expect(await executions.request("saveToWorkspace", payload)).toEqual(reply);
    expect(run).toHaveBeenCalledTimes(2);
    expect(await executions.request("saveToWorkspace", { ...payload, callId: "stopped" })).toEqual(
      reply,
    );
  });

  it("aborts running work and waits for its finalizers during disposal", async () => {
    const started = Promise.withResolvers<void>();
    const cleaning = Promise.withResolvers<void>();
    const cleaned = Promise.withResolvers<void>();
    const executions = makeExecutions((_tag, _payload, signal) =>
      Effect.runPromise(
        Effect.sync(() => started.resolve()).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.promise(async () => {
              cleaning.resolve();
              await cleaned.promise;
            }),
          ),
        ),
        { signal },
      ),
    );
    const first = executions.request("saveToWorkspace", payload);
    await started.promise;
    expect(executions.cancelCall("call")).toBe(true);
    await cleaning.promise;
    expect(executions.active).toBe(1);
    let disposed = false;
    const disposing = executions.dispose().then(() => {
      disposed = true;
    });
    expect(disposed).toBe(false);
    cleaned.resolve();
    await disposing;
    expect(await first).toMatchObject({ ok: false });
    expect(executions.active).toBe(0);
    expect(
      await executions.request("saveToWorkspace", { ...payload, callId: "new" }),
    ).toMatchObject({
      ok: false,
    });
  });

  it("gives each app lifetime a new execution identity", () => {
    const first = makeExecutions(async () => reply);
    expect(first.id).not.toBe(makeExecutions(async () => reply).id);
  });
});
