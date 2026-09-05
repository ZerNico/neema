import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSync } from "./use-sync.ts";

import { FakeEventSource } from "../../../../tests/fixtures/event-source.ts";

function Probe() {
  useSync();
  return null;
}

const renderSync = () => {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
  return { invalidate, source: FakeEventSource.instances.at(-1)! };
};

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSync", () => {
  it("connects once and leaves fresh queries alone on the first open", () => {
    const { invalidate, source } = renderSync();
    expect(source.url).toBe("/api/sync");

    source.emit("open");

    // Mounting queries fetch on their own; invalidating here would
    // double-fetch every page load.
    expect(invalidate).not.toHaveBeenCalled();
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
