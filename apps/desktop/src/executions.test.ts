import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeExecutions } from "./executions.ts";
import { refusalReply } from "@chat/desktop-rpc";

const payload = { callId: "call", conversationId: "chat", path: "work/file.txt" };
const reply = { ok: true, value: { text: "hello" } } as const;

describe("main-process executions", () => {
  it("deduplicates in-flight and completed calls across renderer clients", async () => {
    const finish = Promise.withResolvers<typeof reply>();
    const started = Promise.withResolvers<void>();
    const run = vi.fn(() => {
      started.resolve();
      return finish.promise;
    });
    const executions = makeExecutions(run);
    const first = executions.request("readFile", payload);
    await started.promise;
    const reloaded = executions.request("readFile", {
      path: payload.path,
      conversationId: "chat",
      callId: "call",
    });
    expect(first).toBe(reloaded);
    finish.resolve(reply);
    expect(await first).toEqual(reply);
    expect(await executions.request("readFile", payload)).toEqual(reply);
    expect(run).toHaveBeenCalledTimes(1);
    await executions.dispose();
  });

  it("rejects changed payloads, but permits readFile then readBinary under one call id", async () => {
    const run = vi.fn(async () => reply);
    const executions = makeExecutions(run);
    await executions.request("readFile", payload);
    expect(await executions.request("readFile", { ...payload, path: "work/other" })).toMatchObject({
      ok: false,
    });
    expect(await executions.request("readBinary", payload)).toEqual(reply);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("retains failures, rather than retrying their effects", async () => {
    const failure = refusalReply("not-found", "Missing.");
    const run = vi.fn(async () => failure);
    const executions = makeExecutions(run);
    expect(await executions.request("readFile", payload)).toEqual(failure);
    expect(await executions.request("readFile", payload)).toEqual(failure);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("tombstones delayed requests even when cancellation arrives first", async () => {
    const run = vi.fn(async () => reply);
    const executions = makeExecutions(run);
    expect(executions.cancelCall("call")).toBe(false);
    expect(await executions.request("writeFile", payload)).toMatchObject({ ok: false });
    expect(await executions.request("readBinary", payload)).toMatchObject({ ok: false });
    expect(run).not.toHaveBeenCalled();
  });

  it("aborts running fibers and waits for their finalizers during disposal", async () => {
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
    const first = executions.request("runCommand", payload);
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
    expect(await executions.request("writeFile", { ...payload, callId: "new" })).toMatchObject({
      ok: false,
    });
  });

  it("never evicts active work to meet retention or capacity limits", async () => {
    let now = 0;
    const finish = Promise.withResolvers<typeof reply>();
    const run = vi.fn(() => finish.promise);
    const executions = makeExecutions(run, { now: () => now, retentionMs: 10, maxEntries: 1 });
    const first = executions.request("readFile", payload);
    now = 100;
    expect(await executions.request("readFile", { ...payload, callId: "second" })).toMatchObject({
      ok: false,
    });
    expect(executions.request("readFile", payload)).toBe(first);
    finish.resolve(reply);
    await first;
    now = 111;
    expect(await executions.request("readFile", { ...payload, callId: "second" })).toEqual(reply);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("bounds cached reply bytes without allowing the operation to run again", async () => {
    const run = vi.fn(async () => reply);
    const executions = makeExecutions(run, { maxBytes: 1 });
    expect(await executions.request("readFile", payload)).toEqual(reply);
    expect(await executions.request("readFile", payload)).toMatchObject({ ok: false });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("gives each app lifetime a new execution identity", () => {
    const first = makeExecutions(async () => reply);
    expect(first.id).toBe(first.id);
    expect(first.id).not.toBe(makeExecutions(async () => reply).id);
  });
});
