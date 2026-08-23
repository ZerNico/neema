import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { useMessageStream } from "./use-message-stream.ts";

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

  emit(type: string, data: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent);
    }
  }
}

const renderStream = () => {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useMessageStream("m1", null, "c1"), { wrapper });
  return { result, invalidate, source: FakeEventSource.instances.at(-1)! };
};

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useMessageStream smoothing", () => {
  it("holds the reported completion until every word is on screen", () => {
    const { result, invalidate, source } = renderStream();

    // The provider's last chunk and its done arrive back to back.
    act(() => source.emit("chunk", { seq: 1, delta: "A final chunk of several words" }));
    act(() => source.emit("done", { status: "complete" }));

    // Raw state is complete, but the display hasn't caught up — consumers
    // still see a streaming message and the canonical refetch waits.
    expect(result.current.status).toBe("streaming");
    expect(result.current.text).not.toBe("A final chunk of several words");
    expect(invalidate).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(30 * 12));

    expect(result.current.text).toBe("A final chunk of several words");
    expect(result.current.status).toBe("complete");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["conversation", "c1"] });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("reports an error immediately, even with words still in flight", () => {
    const { result, invalidate, source } = renderStream();

    act(() => source.emit("chunk", { seq: 1, delta: "Half an answer before the crash" }));
    act(() => source.emit("done", { status: "error" }));

    expect(result.current.status).toBe("error");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["conversation", "c1"] });
  });

  it("keeps lastSeq exact regardless of what is displayed", () => {
    const { result, source } = renderStream();

    act(() => source.emit("chunk", { seq: 1, delta: "Many words arriving all at once here" }));
    act(() => source.emit("chunk", { seq: 2, delta: " and then some more" }));

    // Resume bookkeeping tracks receipt, not the paced display.
    expect(result.current.lastSeq).toBe(2);
    expect(result.current.text.length).toBeLessThan("Many words arriving all at once here".length);
  });
});
