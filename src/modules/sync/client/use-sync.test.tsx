import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSync } from "./use-sync.ts";

import { FakeEventSource } from "../../../../tests/fixtures/event-source.ts";

function Probe({ reconcile }: { reconcile?: (() => Promise<boolean>) | undefined }) {
  useSync(reconcile);
  return null;
}

const renderSync = (reconcile?: () => Promise<boolean>) => {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const view = render(
    <QueryClientProvider client={client}>
      <Probe reconcile={reconcile} />
    </QueryClientProvider>,
  );
  return { invalidate, source: FakeEventSource.instances.at(-1)!, unmount: view.unmount };
};

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useSync", () => {
  it("coalesces indexing bursts into knowledge-only invalidation without starving refresh", async () => {
    vi.useFakeTimers();
    const { invalidate, source } = renderSync();
    source.emit("sync", { type: "knowledge.index.changed" });
    vi.advanceTimersByTime(200);
    for (let i = 0; i < 20; i++) source.emit("sync", { type: "knowledge.index.changed" });
    expect(invalidate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(invalidate.mock.calls).toEqual([
      [{ queryKey: ["knowledge"] }, { cancelRefetch: false }],
    ]);
    source.emit("sync", { type: "knowledge.index.changed" });
    vi.advanceTimersByTime(250);
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("lets slow refreshes finish and coalesces intervening events into one follow-up", async () => {
    vi.useFakeTimers();
    const { invalidate, source } = renderSync();
    let release!: () => void;
    invalidate.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    source.emit("sync", { type: "knowledge.index.changed" });
    await vi.advanceTimersByTimeAsync(250);
    for (let i = 0; i < 8; i++) {
      source.emit("sync", { type: "knowledge.index.changed" });
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(invalidate).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(250);
    expect(invalidate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it.each(["unmount", "reconnect", "resources"] as const)(
    "clears queued indexing invalidation on %s",
    async (action) => {
      vi.useFakeTimers();
      const { invalidate, source, unmount } = renderSync();
      source.emit("open");
      await vi.advanceTimersByTimeAsync(0);
      source.emit("sync", { type: "knowledge.index.changed" });
      if (action === "unmount") unmount();
      else if (action === "reconnect") source.emit("open");
      else source.emit("sync", { type: "resources.changed" });
      invalidate.mockClear();
      vi.advanceTimersByTime(250);
      expect(invalidate).not.toHaveBeenCalled();
    },
  );

  it("reconciles knowledge on first open without refreshing unrelated queries", () => {
    const { invalidate, source } = renderSync();
    expect(source.url).toBe("/api/sync");

    source.emit("open");

    expect(invalidate.mock.calls).toEqual([
      [{ queryKey: ["knowledge"] }, { cancelRefetch: false }],
    ]);
  });

  it("refetches lists and details after a reconnect", () => {
    const { invalidate, source } = renderSync();
    source.emit("open");

    // The gap between these two opens is where events are lost for good —
    // the bus has no replay, so the reopen must assume it missed some.
    source.emit("open");

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["conversations"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["conversation"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["memory"] });
  });

  it("refetches authorized models and admin order after a policy change or reconnect", () => {
    const { invalidate, source } = renderSync();
    source.emit("sync", { type: "models.defaults.changed" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["chat-models"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin", "models"] });
    invalidate.mockClear();
    source.emit("open");
    source.emit("open");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["chat-models"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin", "models"] });
  });

  it("refetches authorized resources after a content-free change or reconnect", async () => {
    const { invalidate, source } = renderSync();
    source.emit("sync", { type: "resources.changed" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["sharing"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["chat-models"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin", "groups"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin", "group-members"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["knowledge"] }, { cancelRefetch: false });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["agents"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["conversation"] });
    await Promise.resolve();
    await Promise.resolve();
    invalidate.mockClear();
    source.emit("open");
    source.emit("open");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["sharing"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["chat-models"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin", "groups"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin", "group-members"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["knowledge"] }, { cancelRefetch: false });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["agents"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["conversation"] });
  });

  it("still applies ordinary events after reconnecting", () => {
    const { invalidate, source } = renderSync();
    source.emit("open");
    source.emit("open");
    invalidate.mockClear();

    source.emit("sync", {
      type: "message.status",
      conversationId: "c1",
      messageId: "m1",
      status: "complete",
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["conversation", "c1"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["conversations"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["memory"] });
  });

  it.each([
    {
      type: "conversation.updated",
      conversationId: "c1",
    },
    {
      type: "conversation.deleted",
      conversationId: "c1",
    },
    {
      type: "message.created",
      conversationId: "c1",
      messageId: "m1",
    },
  ] as const)("refreshes memory provenance after $type", (event) => {
    const { invalidate, source } = renderSync();

    source.emit("sync", event);

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["memory"] });
  });

  it.each(["memory.changed", "memory.policy.changed"] as const)(
    "invalidates the memory prefix for %s",
    (type) => {
      const { invalidate, source } = renderSync();

      source.emit("sync", { type });

      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["memory"] });
    },
  );
});

describe("identity-gated reconnects", () => {
  it("retries a failed identity check before applying events and cancels retry on disposal", async () => {
    vi.useFakeTimers();
    const reconcile = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const { invalidate, source, unmount } = renderSync(reconcile);
    source.emit("open");
    await vi.advanceTimersByTimeAsync(0);
    source.emit("sync", { type: "memory.changed" });
    expect(invalidate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["conversations"] });
    invalidate.mockClear();
    source.emit("sync", { type: "memory.changed" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["memory"] });
    reconcile.mockResolvedValue(false);
    source.emit("open");
    await vi.advanceTimersByTimeAsync(0);
    unmount();
    const calls = reconcile.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(reconcile).toHaveBeenCalledTimes(calls);
  });

  it("ignores an old connection's late authorization result", async () => {
    let resolve!: (valid: boolean) => void;
    const reconcile = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<boolean>((done) => {
          resolve = done;
        }),
      )
      .mockResolvedValue(false);
    const { invalidate, source, unmount } = renderSync(reconcile);
    source.emit("open");
    source.emit("error");
    source.emit("open");
    resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    source.emit("sync", { type: "memory.changed" });
    expect(invalidate).not.toHaveBeenCalled();
    unmount();
  });
});
