import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkController, type WorkDependencies, type WorkSnapshot } from "./work-controller.ts";
import type { ExternalOperation } from "~/modules/tools/server/external-completion.ts";

const result = { v: 1 as const, ok: true, summary: "Saved", detail: "done", truncated: false };
const call = (id: string, conversationId = "a"): ExternalOperation => ({
  userId: "u",
  conversationId,
  messageId: `m-${conversationId}`,
  generationId: `g-${conversationId}`,
  executorId: "e",
  callId: id,
  name: "write_local_file",
  args: { path: "site/a", text: "$&" },
  expiresAt: Date.now() + 1000,
  claimed: false,
});
const snapshot = (...calls: ExternalOperation[]): WorkSnapshot => ({
  calls,
  attempts: calls,
  settings: [...new Set(calls.map((c) => c.conversationId))].map((conversationId) => ({
    conversationId,
    title: conversationId,
    approval: "auto",
    network: "none",
  })),
});
const controllers: WorkController[] = [];
function setup(overrides: Partial<WorkDependencies> = {}) {
  const completed = deferred<void>();
  const deps: WorkDependencies = {
    beforeExecute: async () => {},
    claim: vi.fn(async () => "token"),
    execute: vi.fn(async () => result),
    complete: vi.fn(async () => {
      completed.resolve();
      return true;
    }),
    cancel: vi.fn(),
    changed: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };
  const controller = new WorkController(deps);
  controllers.push(controller);
  return { controller, deps, completed: completed.promise };
}
afterEach(() => {
  controllers.splice(0).forEach((c) => c.dispose());
  vi.useRealTimers();
});

describe("app-owned Work execution", () => {
  it("does not resend an acknowledged result on unrelated refreshes", async () => {
    const { controller, deps, completed } = setup();
    const current = snapshot(call("one"));
    controller.reconcile(current);
    controller.decide("one", "allow");
    await completed;
    await Promise.resolve();
    controller.reconcile(current);
    expect(deps.complete).toHaveBeenCalledTimes(1);
  });

  it.each(["expiry", "removal", "identity"] as const)(
    "cancels delivery retries on %s",
    async (reason) => {
      vi.useFakeTimers();
      const failed = deferred<void>();
      const complete = vi.fn(async (): Promise<boolean> => {
        throw new Error("offline");
      });
      const { controller, deps } = setup({ complete, error: () => failed.resolve() });
      controller.reconcile(snapshot(call("one")));
      controller.decide("one", "allow");
      await failed.promise;
      if (reason === "removal") controller.reconcile(snapshot());
      if (reason === "identity") controller.dispose();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(deps.execute).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["manual", "auto", "skip"] as const)(
    "honours %s approval policy and always asks about deletes",
    (approval) => {
      const { controller } = setup();
      const current = snapshot(
        call("edit"),
        { ...call("read"), name: "read_local_file" },
        { ...call("command"), name: "run_command" },
        { ...call("delete"), name: "delete_local_file" },
      );
      current.settings[0]!.approval = approval;
      controller.reconcile(current);
      const pending = controller.pending("a");
      expect(pending.has("read")).toBe(approval === "manual");
      expect(pending.has("edit")).toBe(approval !== "skip");
      expect(pending.has("command")).toBe(approval !== "skip");
      expect(pending.get("delete")).toBe("delete");
    },
  );

  it("does not extend an edit grant to commands, deletes, or manual reads", async () => {
    const { controller, completed } = setup();
    const current = snapshot(
      call("edit"),
      { ...call("read"), name: "read_local_file" },
      { ...call("command"), name: "run_command" },
      { ...call("delete"), name: "delete_local_file" },
    );
    current.settings[0]!.approval = "manual";
    controller.reconcile(current);
    controller.decide("edit", "allow-rest");
    await completed;
    expect([...controller.pending("a").keys()]).toEqual(["read", "command", "delete"]);
  });

  it("reports a refusal without executing and reads changed policy on the next call", async () => {
    const { controller, deps, completed } = setup();
    controller.reconcile(snapshot(call("one")));
    controller.decide("one", "deny");
    await completed;
    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.complete).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "one" }),
      "token",
      expect.objectContaining({ ok: false }),
    );
    const next = snapshot(call("two"));
    next.settings[0]!.approval = "skip";
    controller.reconcile(next);
    expect(controller.pending("a").size).toBe(0);
  });
  it("keeps independent chats alive without mounted transcript views", async () => {
    const { controller, deps, completed } = setup();
    controller.reconcile(snapshot(call("one"), call("two", "b")));
    controller.decide("one", "allow-rest");
    await completed;
    expect(deps.execute).toHaveBeenCalledTimes(1);
    expect(controller.pending("b").has("two")).toBe(true);
    expect(controller.attention().map((s) => s.conversationId)).toEqual(["b"]);
  });

  it("a terminal call cannot be revived by a later blanket approval", async () => {
    const { controller, deps, completed } = setup();
    const old = call("old"),
      next = call("next");
    controller.reconcile(snapshot(old, next));
    controller.reconcile(snapshot(next));
    controller.decide("next", "allow-rest");
    await completed;
    expect(deps.execute).toHaveBeenCalledTimes(1);
    expect(deps.execute).toHaveBeenCalledWith(next, "none");
    expect(deps.cancel).toHaveBeenCalledWith("old");
  });

  it("checks expiry before allowing a group even if its timer has not run", async () => {
    vi.useFakeTimers();
    const { controller, deps, completed } = setup();
    const old = call("old"),
      next = { ...call("next"), expiresAt: Date.now() + 5000 };
    controller.reconcile(snapshot(old, next));
    vi.setSystemTime(Date.now() + 2000);
    controller.decide("next", "allow-rest");
    await completed;
    expect(deps.execute).toHaveBeenCalledTimes(1);
    expect(deps.cancel).toHaveBeenCalledWith("old");
  });

  it("rechecks cancellation after a claim returns", async () => {
    const claiming = deferred<void>();
    const claimReply = deferred<string | null>();
    const { controller, deps } = setup({
      claim: () => {
        claiming.resolve();
        return claimReply.promise;
      },
    });
    controller.reconcile(snapshot(call("one")));
    controller.decide("one", "allow");
    await claiming.promise;
    controller.reconcile(snapshot());
    claimReply.resolve("token");
    await claimReply.promise;
    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.cancel).toHaveBeenCalledWith("one");
  });

  it("retries lost result delivery without another snapshot or repeating the side effect", async () => {
    vi.useFakeTimers();
    const failed = deferred<void>();
    const delivered = deferred<void>();
    let attempts = 0;
    const { controller, deps } = setup({
      complete: async () => {
        if (++attempts === 1) throw new Error("connection lost");
        delivered.resolve();
        return true;
      },
      error: () => failed.resolve(),
    });
    const current = snapshot({ ...call("one"), expiresAt: Date.now() + 30_000 });
    controller.reconcile(current);
    controller.decide("one", "allow");
    await failed.promise;
    controller.reconcile(current);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    await delivered.promise;
    expect(deps.execute).toHaveBeenCalledTimes(1);
    expect(attempts).toBe(2);
  });

  it("does not claim before first-send folder rebinding finishes", async () => {
    const barrier = deferred<void>();
    const beforeExecute = vi.fn(() => barrier.promise);
    const { controller, deps, completed } = setup({ beforeExecute });
    controller.reconcile(snapshot(call("one")));
    controller.decide("one", "allow");
    expect(deps.claim).not.toHaveBeenCalled();
    barrier.resolve();
    await completed;
    expect(deps.execute).toHaveBeenCalledTimes(1);
    expect(beforeExecute).toHaveBeenCalledWith("a");
  });

  it("deduplicates concurrent snapshot refreshes while execution is pending", async () => {
    const started = deferred<void>();
    const finish = deferred<typeof result>();
    const execute = vi.fn(async () => {
      started.resolve();
      return finish.promise;
    });
    const { controller, completed } = setup({ execute });
    const current = snapshot(call("one"));
    controller.reconcile(current);
    controller.decide("one", "allow");
    await started.promise;
    controller.reconcile(current);
    controller.reconcile(current);
    finish.resolve(result);
    await completed;
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("identity teardown cancels calls and cannot be restarted by a late snapshot", () => {
    const { controller, deps } = setup();
    const current = snapshot(call("one"));
    controller.reconcile(current);
    controller.dispose();
    controller.reconcile(current);
    controller.decide("one", "allow-rest");
    expect(deps.cancel).toHaveBeenCalledWith("one");
    expect(deps.execute).not.toHaveBeenCalled();
  });
});

function deferred<A>() {
  let resolve!: (value: A | PromiseLike<A>) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
