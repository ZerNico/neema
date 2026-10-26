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
  name: "write_file",
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
    approval: "ask",
  })),
});
const controllers: WorkController[] = [];
function setup(overrides: Partial<WorkDependencies> = {}) {
  const completed = deferred<void>();
  const deps: WorkDependencies = {
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

  it.each(["ask", "allow"] as const)(
    "honours %s approval policy, never asks about reads and always about deletes and network access",
    (approval) => {
      const { controller } = setup();
      const current = snapshot(
        call("edit"),
        { ...call("read"), name: "read_file" },
        { ...call("command"), name: "run_command" },
        {
          ...call("network"),
          name: "request_network_access",
          args: { host: "example.com" },
        },
        { ...call("delete"), name: "delete_files" },
      );
      current.settings[0]!.approval = approval;
      controller.reconcile(current);
      const pending = controller.pending("a");
      expect(pending.has("read")).toBe(false);
      expect(pending.has("edit")).toBe(approval === "ask");
      expect(pending.has("command")).toBe(approval === "ask");
      expect(pending.get("delete")).toBe("delete");
      expect(pending.get("network")).toBe("network");
    },
  );

  it("does not extend an edit grant to commands or deletes", async () => {
    const { controller, completed } = setup();
    const current = snapshot(
      call("edit"),
      { ...call("read"), name: "read_file" },
      { ...call("command"), name: "run_command" },
      { ...call("delete"), name: "delete_files" },
    );
    controller.reconcile(current);
    controller.decide("edit", "allow-rest");
    await completed;
    expect([...controller.pending("a").keys()]).toEqual(["command", "delete"]);
  });

  it.each(["ask", "allow"] as const)(
    "requires individual network consent under %s even after a blanket decision",
    async (approval) => {
      const { controller, deps, completed } = setup();
      const first = {
        ...call("network"),
        name: "request_network_access",
        args: { host: "one.example" },
      };
      const next = {
        ...call("next-network"),
        name: "request_network_access",
        args: { host: "two.example" },
      };
      const current = snapshot(first, next);
      current.settings[0]!.approval = approval;
      controller.reconcile(current);
      expect(controller.pending("a").size).toBe(2);
      expect(deps.execute).not.toHaveBeenCalled();
      controller.decide("network", "allow-rest");
      await completed;
      expect(deps.execute).toHaveBeenCalledExactlyOnceWith(
        first,
        expect.any(Number),
        expect.any(Function),
        "answer",
      );
      expect(controller.pending("a").get("next-network")).toBe("network");
      const subsequent = snapshot({ ...next, callId: "future-network" });
      subsequent.settings[0]!.approval = approval;
      controller.reconcile(subsequent);
      expect(controller.pending("a").get("future-network")).toBe("network");
      expect(deps.execute).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["allow", "answer"],
    ["allow-chat", "chat"],
    ["allow-always", "always"],
  ] as const)("passes the network scope the person chose: %s", async (choice, scope) => {
    const { controller, deps, completed } = setup();
    const request = {
      ...call("network"),
      name: "request_network_access",
      args: { host: "one.example" },
    };
    controller.reconcile(snapshot(request));
    controller.decide("network", choice);
    await completed;
    expect(deps.execute).toHaveBeenCalledExactlyOnceWith(
      request,
      expect.any(Number),
      expect.any(Function),
      scope,
    );
  });

  it("declines network access without invoking the desktop grant", async () => {
    const { controller, deps, completed } = setup();
    controller.reconcile(snapshot({ ...call("network"), name: "request_network_access" }));
    controller.decide("network", "deny");
    await completed;
    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.complete).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "network" }),
      "token",
      expect.objectContaining({ ok: false, summary: "You declined that" }),
    );
  });

  it.each(["expiry", "removal", "identity"] as const)(
    "cannot approve a pending network request after %s",
    (reason) => {
      vi.useFakeTimers();
      const { controller, deps } = setup();
      controller.reconcile(snapshot({ ...call("network"), name: "request_network_access" }));
      if (reason === "expiry") vi.setSystemTime(Date.now() + 2000);
      if (reason === "removal") controller.reconcile(snapshot());
      if (reason === "identity") controller.dispose();
      controller.decide("network", "allow");
      expect(deps.claim).not.toHaveBeenCalled();
      expect(deps.execute).not.toHaveBeenCalled();
      expect(deps.cancel).toHaveBeenCalledWith("network");
    },
  );

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
    next.settings[0]!.approval = "allow";
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
    expect(deps.execute).toHaveBeenCalledWith(
      next,
      expect.any(Number),
      expect.any(Function),
      "answer",
    );
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

const open = (id: string, url: unknown, meta?: ExternalOperation["meta"]): ExternalOperation => ({
  ...call(id),
  name: "browser_open",
  args: url === undefined ? {} : { url },
  ...(meta ? { meta } : {}),
});

describe("browser sites", () => {
  it("opens a site the server vouched for without asking anyone", async () => {
    const siteAllowed = vi.fn(async () => false);
    const { controller, deps, completed } = setup({ siteAllowed });
    controller.reconcile(snapshot(open("one", "https://a.test", { preauthorized: true })));
    await completed;
    expect(siteAllowed).not.toHaveBeenCalled();
    expect(deps.execute).toHaveBeenCalledTimes(1);
  });

  it("opens an allowed site after checking, and asks about any other", async () => {
    const checked = deferred<void>();
    const siteAllowed = vi.fn(async (operation: ExternalOperation) => {
      checked.resolve();
      return operation.args.url === "https://allowed.test";
    });
    const { controller, deps, completed } = setup({ siteAllowed });
    controller.reconcile(
      snapshot(open("yes", "https://allowed.test"), open("no", "https://other.test")),
    );
    // Neither asks while the desktop is still answering.
    expect(controller.pending("a").size).toBe(0);
    await checked.promise;
    await completed;
    expect(deps.execute).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect([...controller.pending("a")]).toEqual([["no", "site"]]));
  });

  it("treats a navigation without an address as a read", async () => {
    const siteAllowed = vi.fn(async () => false);
    const { controller, completed } = setup({ siteAllowed });
    controller.reconcile(snapshot({ ...open("back", undefined), name: "browser_navigate" }));
    await completed;
    expect(siteAllowed).not.toHaveBeenCalled();
  });

  it.each([
    ["allow", null],
    ["allow-chat", "chat"],
    ["allow-always", "always"],
  ] as const)("%s runs the call and remembers it for %s", async (choice, scope) => {
    let allowed = false;
    const allowSite = vi.fn(async () => {
      allowed = true;
    });
    const siteAllowed = vi.fn(async () => allowed);
    const { controller, deps } = setup({ siteAllowed, allowSite });
    controller.reconcile(snapshot(open("one", "https://a.test"), open("two", "https://a.test")));
    await vi.waitFor(() => expect(controller.pending("a").size).toBe(2));
    controller.decide("one", choice);
    if (scope) {
      expect(allowSite).toHaveBeenCalledWith(expect.objectContaining({ callId: "one" }), scope);
      // The other call for the same site now finds it allowed and runs too.
      await vi.waitFor(() => expect(deps.execute).toHaveBeenCalledTimes(2));
      expect(controller.pending("a").size).toBe(0);
    } else {
      await vi.waitFor(() => expect(deps.execute).toHaveBeenCalledTimes(1));
      expect(allowSite).not.toHaveBeenCalled();
      expect([...controller.pending("a")]).toEqual([["two", "site"]]);
    }
  });

  it.each([
    ["allow-chat", true, "chat"],
    ["allow", true, null],
    ["deny", false, null],
  ] as const)(
    "asks while a call runs about a site it was led to: %s",
    async (choice, allowed, scope) => {
      const answer = deferred<boolean>();
      const allowSite = vi.fn(async () => {});
      const execute: WorkDependencies["execute"] = async (_call, _ms, askSite) => {
        answer.resolve(await askSite("https://led.test/page"));
        return result;
      };
      const { controller, completed } = setup({ execute, allowSite });
      const click = { ...call("click"), name: "browser_click", args: { tab: "t1", ref: "e1" } };
      controller.reconcile({
        ...snapshot(click),
        settings: [{ conversationId: "a", title: "a", approval: "allow" }],
      });
      await vi.waitFor(() => expect([...controller.pending("a")]).toEqual([["click", "site"]]));
      // The card asks about the address the click led to.
      expect(controller.args("click")).toMatchObject({ url: "https://led.test/page" });
      controller.decide("click", choice);
      expect(await answer.promise).toBe(allowed);
      await completed;
      expect(controller.pending("a").size).toBe(0);
      if (scope)
        expect(allowSite).toHaveBeenCalledWith(
          expect.objectContaining({
            args: expect.objectContaining({ url: "https://led.test/page" }),
          }),
          scope,
        );
      else expect(allowSite).not.toHaveBeenCalled();
    },
  );

  it("never lets allow-rest cover a site", async () => {
    const { controller, deps } = setup({ siteAllowed: async () => false });
    controller.reconcile(snapshot(open("one", "https://a.test"), open("two", "https://b.test")));
    await vi.waitFor(() => expect(controller.pending("a").size).toBe(2));
    controller.decide("one", "allow-rest");
    await vi.waitFor(() => expect(deps.execute).toHaveBeenCalledTimes(1));
    expect([...controller.pending("a")]).toEqual([["two", "site"]]);
  });
});

function deferred<A>() {
  let resolve!: (value: A | PromiseLike<A>) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
