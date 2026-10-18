import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { IntegrationActivityBlock } from "~/modules/integrations/ui/integration-activity-block.tsx";
import { listPendingIntegrationCalls } from "~/modules/integrations/server/functions.ts";
import { pendingIntegrationCallsQuery } from "~/modules/integrations/client/queries.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_SESSION_CREATED_EVENT } from "~/modules/auth/ticket-events.ts";
import { discardWorkspace } from "~/modules/desktop/client/bridge.ts";
import { useSync } from "./use-sync.ts";

vi.mock("~/modules/desktop/client/bridge.ts", () => ({ discardWorkspace: vi.fn() }));
vi.mock("~/modules/integrations/server/functions.ts", () => ({
  listPendingIntegrationCalls: vi.fn(),
  listIntegrationDirectory: vi.fn().mockResolvedValue([]),
}));

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

const missedPrefixes = [
  ["drafts"],
  ["integrations"],
  ["admin", "integrations"],
  ["integration-approvals"],
  ["desktop-sessions"],
  ["search", "recent-chats"],
  ["search", "chats"],
] as const;

function CachedFamily({ queryKey }: { queryKey: readonly string[] }) {
  const query = useQuery({ queryKey, queryFn: async () => "fresh", staleTime: Infinity });
  return <output aria-label={queryKey.join("/")}>{query.data}</output>;
}

describe("useSync", () => {
  it.each(["reopen", "sync.ready"])(
    "repairs every missed feed-owned family on %s",
    async (recovery) => {
      const client = new QueryClient();
      const invalidate = vi.spyOn(client, "invalidateQueries");
      for (const queryKey of missedPrefixes) client.setQueryData(queryKey, "stale");
      client.setQueryData(["unrelated"], "untouched");
      render(
        <QueryClientProvider client={client}>
          <Probe />
          {missedPrefixes.map((queryKey) => (
            <CachedFamily key={queryKey.join("/")} queryKey={queryKey} />
          ))}
          <CachedFamily queryKey={["unrelated"]} />
        </QueryClientProvider>,
      );
      const source = FakeEventSource.instances.at(-1)!;
      act(() => source.emit("open"));
      for (const queryKey of missedPrefixes)
        expect(screen.getByLabelText(queryKey.join("/"))).toHaveTextContent("stale");
      act(() => {
        if (recovery === "reopen") {
          source.emit("error");
          source.emit("open");
        } else source.emit("sync", { type: "sync.ready" });
      });
      await waitFor(() => {
        for (const queryKey of missedPrefixes)
          expect(screen.getByLabelText(queryKey.join("/"))).toHaveTextContent("fresh");
      });
      expect(screen.getByLabelText("unrelated")).toHaveTextContent("untouched");
      expect(invalidate.mock.calls.every(([filter]) => filter?.queryKey?.length)).toBe(true);
    },
  );

  it("discovers a missed approval in the real activity card after recovery", async () => {
    vi.mocked(listPendingIntegrationCalls).mockResolvedValue([
      {
        kind: "approval",
        callId: "call",
        conversationId: "chat",
        messageId: "message",
        integrationId: "service",
        tool: "read",
        label: "Search",
        promptId: "prompt",
        access: "read",
        summary: null,
        targets: [],
        expiresAt: Date.now() + 60_000,
      },
    ]);
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    client.setQueryData(pendingIntegrationCallsQuery.queryKey, []);
    render(
      <QueryClientProvider client={client}>
        <Probe />
        <IntegrationActivityBlock
          activity={{
            callId: "call",
            name: "integration_service__read",
            family: "integration",
            status: "running",
            integrationId: "service",
            tool: "read",
            label: "Read a page",
            access: "read",
            summary: null,
          }}
        />
      </QueryClientProvider>,
    );
    const source = FakeEventSource.instances.at(-1)!;
    act(() => source.emit("open"));
    expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument();
    act(() => source.emit("sync", { type: "sync.ready" }));
    expect(await screen.findByRole("button", { name: "Allow" })).toBeInTheDocument();
    expect(listPendingIntegrationCalls).toHaveBeenCalledOnce();
  });
  it("refreshes work policy on conversation changes and preserves in-flight invalidations", async () => {
    const { invalidate, source } = renderSync();
    let release!: () => void;
    invalidate.mockImplementation((filter) =>
      filter?.queryKey?.[0] === "desktop-work"
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : Promise.resolve(),
    );
    source.emit("sync", { type: "conversation.updated", conversationId: "c" });
    source.emit("sync", { type: "desktop.work.changed" });
    const workCalls = () =>
      invalidate.mock.calls.filter(([filter]) => filter?.queryKey?.[0] === "desktop-work");
    expect(workCalls()).toHaveLength(1);
    release();
    await Promise.resolve();
    expect(workCalls()).toHaveLength(2);
    release();
  });

  it("reconciles again when the server's database listener reconnects", () => {
    const { invalidate, source } = renderSync();
    source.emit("open");
    invalidate.mockClear();
    source.emit("sync", { type: "sync.ready" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["conversation"] });
  });

  it("discovers late drafts by refreshing both settings and the conversation summary", () => {
    const { invalidate, source } = renderSync();
    source.emit("sync", {
      type: "draft.changed",
      kind: "agent",
      conversationId: "c1",
      draftId: "d1",
    });
    expect(invalidate.mock.calls).toEqual([
      [{ queryKey: ["drafts", "agent", "d1"] }],
      [{ queryKey: ["conversation", "c1"] }],
    ]);
  });

  it("refreshes one document and both summary lists when a document changes", () => {
    const { invalidate, source } = renderSync();
    source.emit("sync", { type: "document.changed", conversationId: "c1", documentId: "doc1" });
    expect(invalidate.mock.calls).toEqual([
      [{ queryKey: ["documents", "doc1"] }],
      [{ queryKey: ["documents", "list", "c1"] }],
      [{ queryKey: ["conversation", "c1"] }],
    ]);
  });

  it("leaves the chat's detail alone when only a document's text changed", () => {
    const { invalidate, source } = renderSync();
    source.emit("sync", {
      type: "document.changed",
      conversationId: "c1",
      documentId: "doc1",
      textOnly: true,
    });
    expect(invalidate.mock.calls).toEqual([
      [{ queryKey: ["documents", "doc1"] }],
      [{ queryKey: ["documents", "list", "c1"] }],
    ]);
  });

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

  it("reconciles knowledge and desktop work on first open", () => {
    const { invalidate, source } = renderSync();
    expect(source.url).toBe("/api/sync");

    source.emit("open");

    expect(invalidate.mock.calls).toEqual([
      [{ queryKey: ["knowledge"] }, { cancelRefetch: false }],
      [{ queryKey: ["desktop-work"] }, { cancelRefetch: false }],
    ]);
  });

  it("refetches lists and details after a reconnect", () => {
    const { invalidate, source } = renderSync();
    source.emit("open");

    // The gap between these two opens is where events are lost for good,
    // since the bus has no replay, so the reopen must assume it missed some.
    source.emit("open");

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["conversations"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["conversation"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["memory"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["documents"] });
  });

  it("refetches authorized models and admin order after a policy change or reconnect", () => {
    const { invalidate, source } = renderSync();
    source.emit("sync", { type: "models.defaults.changed" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["chat-models"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["image-models"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin", "models"] });
    invalidate.mockClear();
    source.emit("open");
    source.emit("open");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["chat-models"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["image-models"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin", "models"] });
  });

  it("refetches authorized resources after a content-free change or reconnect", async () => {
    const { invalidate, source } = renderSync();
    source.emit("sync", { type: "resources.changed" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["sharing"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["chat-models"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["image-models"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin", "groups"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin", "group-members"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["knowledge"] }, { cancelRefetch: false });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["agents"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["conversation"] });
    for (const key of [
      ["capabilities"],
      ["admin", "group-capabilities"],
      ["admin", "default-capabilities"],
      ["schedules"],
      ["schedule"],
      ["schedule-runs"],
      ["documents"],
      ["memory"],
      ["custom-tools"],
      ["skills"],
    ]) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: key });
    }
    await Promise.resolve();
    await Promise.resolve();
    invalidate.mockClear();
    source.emit("open");
    source.emit("open");
    for (const key of [
      ["capabilities"],
      ["admin", "group-capabilities"],
      ["admin", "default-capabilities"],
      ["schedules"],
      ["schedule"],
      ["schedule-runs"],
      ["documents"],
      ["memory"],
      ["custom-tools"],
      ["skills"],
    ]) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: key });
    }
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
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["memory"] });
    // The lists are patched from the event, never re-paged.
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["conversations"] });
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

  it("discards a work chat's local folder only once the chat is purged, not at its delete", () => {
    const { invalidate, source } = renderSync();

    source.emit("sync", { type: "conversation.deleted", conversationId: "c1" });
    expect(discardWorkspace).not.toHaveBeenCalled();

    source.emit("sync", { type: "conversation.purged", conversationId: "c1" });
    expect(discardWorkspace).toHaveBeenCalledExactlyOnceWith("c1");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["conversations"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["search", "recent-chats"] });
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

describe("desktop session events", () => {
  it("refreshes the device list and tells the page which ticket was redeemed", () => {
    const { invalidate, source } = renderSync();
    const heard: unknown[] = [];
    const listener = (event: Event) => heard.push((event as CustomEvent).detail);
    window.addEventListener(DESKTOP_SESSION_CREATED_EVENT, listener);
    try {
      source.emit("sync", { type: "desktop.session.created", ticketId: "t1" });
    } finally {
      window.removeEventListener(DESKTOP_SESSION_CREATED_EVENT, listener);
    }
    expect(invalidate.mock.calls).toEqual([[{ queryKey: ["desktop-sessions"] }]]);
    expect(heard).toEqual([{ ticketId: "t1" }]);
  });
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
    for (const queryKey of missedPrefixes) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey });
    }
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
