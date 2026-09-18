import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { useMessageStream } from "./use-message-stream.ts";

import { FakeEventSource } from "../../../../tests/fixtures/event-source.ts";

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

describe("useMessageStream ask replay", () => {
  it.each(["updated", "read", "conflict"] as const)(
    "invalidates a document query when a streamed %s result identifies it",
    (outcome) => {
      const { source, invalidate } = renderStream();
      const delta = JSON.stringify({
        v: 1,
        family: "document",
        phase: "result",
        callId: "document-1",
        name:
          outcome === "read"
            ? "read_chat_document"
            : outcome === "conflict"
              ? "replace_document"
              : "edit_document",
        outcome,
        documentId: "doc-1",
        documentConversationId: "c1",
        title: "Plan",
        revision: 2,
      });
      act(() => source.emit("chunk", { seq: 1, kind: "tool", delta }));
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["documents", "doc-1"] });
    },
  );

  it("deduplicates question chunks, advances malformed cursors, and completes tool-only responses", () => {
    const { result, source, invalidate } = renderStream();
    const questions = [{ question: "What matters most?", options: [], multiSelect: false }];
    const delta = JSON.stringify({
      v: 1,
      family: "ask",
      phase: "result",
      callId: "ask-1",
      name: "ask_user",
      result: { v: 1, outcome: "presented", questions },
    });
    act(() => source.emit("chunk", { seq: 1, kind: "tool", delta }));
    act(() => source.emit("chunk", { seq: 1, kind: "tool", delta }));
    act(() => source.emit("chunk", { seq: 2, kind: "tool", delta: "null" }));
    expect(result.current.tools).toHaveLength(1);
    expect(result.current.tools[0]).toMatchObject({ family: "ask", status: "complete", questions });
    expect(result.current.lastSeq).toBe(2);
    expect(result.current.status).toBe("streaming");
    act(() => source.emit("done", { status: "complete" }));
    expect(result.current.status).toBe("complete");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["conversation", "c1"] });
  });
});

describe("research attempt identity", () => {
  it("uses the outer run identity for memory replay and clears it on retry", () => {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(
      ({ runId }) => useMessageStream("m1", null, "c1", 0, runId),
      { wrapper, initialProps: { runId: "run-1" } },
    );
    const delta = JSON.stringify({
      v: 1,
      family: "memory",
      phase: "result",
      callId: "memory-1",
      name: "save_memory",
      ok: true,
      outcome: "created",
    });
    const old = FakeEventSource.instances.at(-1)!;
    act(() => old.emit("chunk", { runId: "run-1", seq: 1, kind: "tool", delta }));
    expect(result.current.tools).toHaveLength(1);
    expect(result.current.tools[0]).toMatchObject({
      family: "memory",
      status: "complete",
      outcome: "created",
    });
    rerender({ runId: "run-2" });
    expect(result.current.tools).toEqual([]);
    const current = FakeEventSource.instances.at(-1)!;
    act(() => old.emit("chunk", { runId: "run-1", seq: 2, kind: "tool", delta }));
    expect(result.current.tools).toEqual([]);
    act(() => current.emit("chunk", { runId: "run-2", seq: 1, kind: "tool", delta }));
    expect(result.current.tools).toHaveLength(1);
    act(() => current.emit("chunk", { runId: "run-1", seq: 2, kind: "tool", delta }));
    expect(result.current.lastSeq).toBe(1);
    expect(current.close).toHaveBeenCalled();
  });

  it("resets the reused message cursor across tabs and ignores callbacks from the old subscription", () => {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(
      ({ runId }) => useMessageStream("m1", null, "c1", 0, runId),
      {
        wrapper,
        initialProps: { runId: "run-1" },
      },
    );
    const old = FakeEventSource.instances.at(-1)!;
    expect(old.url).toContain("runId=run-1");
    act(() => old.emit("chunk", { runId: "run-1", seq: 1, delta: "Old text" }));
    expect(result.current.lastSeq).toBe(1);
    rerender({ runId: "run-2" });
    const current = FakeEventSource.instances.at(-1)!;
    expect(current.url).toContain("after=0&runId=run-2");
    expect(result.current.lastSeq).toBe(0);
    act(() => {
      old.emit("chunk", { runId: "run-1", seq: 2, delta: "Late text" });
      old.emit("done", { runId: "run-1", status: "error" });
      current.emit("chunk", { runId: "run-2", seq: 1, delta: "New text" });
    });
    expect(result.current.lastSeq).toBe(1);
    expect(result.current.status).toBe("streaming");
    act(() => vi.advanceTimersByTime(500));
    expect(result.current.text).toBe("New text");
  });

  it("refetches a changed server attempt without applying its done or subsequent chunks", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useMessageStream("m1", null, "c1", 0, "run-1"), {
      wrapper,
    });
    const source = FakeEventSource.instances.at(-1)!;
    act(() => source.emit("done", { runId: "run-2", status: "complete" }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["conversation", "c1"] });
    expect(source.close).toHaveBeenCalled();
    expect(result.current.status).toBe("streaming");
    act(() => source.emit("chunk", { runId: "run-1", seq: 1, delta: "Late" }));
    expect(result.current.lastSeq).toBe(0);
  });
});

describe("useMessageStream smoothing", () => {
  it("holds the reported completion until every word is on screen", () => {
    const { result, invalidate, source } = renderStream();

    // The provider's last chunk and its done arrive back to back.
    act(() => source.emit("chunk", { seq: 1, delta: "A final chunk of several words" }));
    act(() => source.emit("done", { status: "complete" }));

    // Raw state is complete, but the display hasn't caught up, so consumers
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

describe("ordinary image attempt identity", () => {
  const image = {
    v: 1,
    attachment: {
      id: "image",
      fileName: "generated.png",
      size: 68,
      mediaType: "image/png",
      kind: "image",
    },
    textOffset: 0,
    turnIndex: 0,
    eventIndex: 1,
    callIndex: 0,
  };
  it("deduplicates ref-only image chunks and clears them for same-message retries", () => {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(
      ({ runId }) => useMessageStream("m1", null, "c1", 0, runId),
      { wrapper, initialProps: { runId: "generation-1" } },
    );
    const old = FakeEventSource.instances.at(-1)!;
    act(() => {
      old.emit("chunk", {
        runId: "generation-1",
        seq: 1,
        kind: "image",
        delta: JSON.stringify(image),
      });
      old.emit("chunk", {
        runId: "generation-1",
        seq: 2,
        kind: "image",
        delta: JSON.stringify(image),
      });
    });
    expect(result.current.images).toEqual([image]);
    expect(result.current.text).toBe("");
    act(() => old.emit("done", { runId: "generation-1", status: "complete" }));
    expect(result.current.status).toBe("complete");
    rerender({ runId: "generation-2" });
    expect(result.current.images).toEqual([]);
    act(() =>
      old.emit("chunk", {
        runId: "generation-1",
        seq: 3,
        kind: "image",
        delta: JSON.stringify(image),
      }),
    );
    expect(result.current.images).toEqual([]);
    expect(result.current.lastSeq).toBe(0);
  });
});
