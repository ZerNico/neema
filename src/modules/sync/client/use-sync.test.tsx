import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSync } from "./use-sync.ts";

// Stand-in for the browser's EventSource: tests drive `open`/`sync` by hand,
// including the reopen a real one performs silently after a network gap.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  private listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  readonly close = vi.fn();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  emit(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: data === undefined ? "" : JSON.stringify(data) } as MessageEvent);
    }
  }
}

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
  });
});
