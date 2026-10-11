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

describe("presentation writing events", () => {
  it("discards writing callbacks from the previous attempt", () => {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(
      ({ runId }) => useMessageStream("m1", null, "c1", 0, runId),
      { wrapper, initialProps: { runId: "generation-1" } },
    );
    const old = FakeEventSource.instances.at(-1)!;
    const delta = JSON.stringify({
      v: 1,
      id: "edit-1",
      name: "edit_presentation",
      textOffset: 0,
      turnIndex: 0,
    });
    act(() => old.emit("chunk", { runId: "generation-1", seq: 1, kind: "writing", delta }));
    expect(result.current.tools).toHaveLength(1);
    rerender({ runId: "generation-2" });
    expect(result.current.tools).toEqual([]);
    act(() => old.emit("chunk", { runId: "generation-1", seq: 2, kind: "writing", delta }));
    expect(result.current.tools).toEqual([]);
    expect(result.current.live.lastSeq).toBe(0);
  });

  it("shows streamed argument activity and replaces it with the decoded call", () => {
    const { result, source } = renderStream();
    act(() =>
      source.emit("chunk", {
        seq: 1,
        kind: "writing",
        delta: JSON.stringify({
          v: 1,
          id: "edit-1",
          name: "edit_presentation",
          textOffset: 0,
          turnIndex: 0,
        }),
      }),
    );
    expect(result.current.tools).toMatchObject([
      { callId: "writing:edit-1", writing: true, status: "running" },
    ]);
    expect(result.current.files).toEqual([]);
    act(() =>
      source.emit("chunk", {
        seq: 2,
        kind: "tool",
        delta: JSON.stringify({
          v: 1,
          family: "presentation",
          phase: "start",
          callId: "edit-1",
          name: "edit_presentation",
          textOffset: 0,
          turnIndex: 0,
          callIndex: 0,
        }),
      }),
    );
    expect(result.current.tools).toHaveLength(1);
    expect(result.current.tools[0]).toMatchObject({ callId: "edit-1", status: "running" });
    expect(result.current.tools[0]).not.toHaveProperty("writing");
  });

  it("shows a workbook edit being written, then its decoded result", () => {
    const { result, source } = renderStream();
    act(() =>
      source.emit("chunk", {
        seq: 1,
        kind: "writing",
        delta: JSON.stringify({
          v: 1,
          id: "sheet-1",
          name: "edit_spreadsheet",
          textOffset: 0,
          turnIndex: 0,
        }),
      }),
    );
    expect(result.current.tools).toMatchObject([
      { family: "spreadsheet", callId: "writing:sheet-1", writing: true, status: "running" },
    ]);
    const envelope = (phase: "start" | "result", extra: Record<string, unknown>) =>
      source.emit("chunk", {
        seq: phase === "start" ? 2 : 3,
        kind: "tool",
        delta: JSON.stringify({
          v: 1,
          family: "spreadsheet",
          phase,
          callId: "sheet-1",
          name: "edit_spreadsheet",
          ...extra,
        }),
      });
    act(() => envelope("start", { textOffset: 0, turnIndex: 0, callIndex: 0 }));
    act(() =>
      envelope("result", {
        outcome: "working",
        message: "Private draft updated.",
        workingFileId: "book",
        revision: 1,
        formulaErrors: 2,
      }),
    );
    expect(result.current.tools).toEqual([
      expect.objectContaining({
        family: "spreadsheet",
        callId: "sheet-1",
        status: "complete",
        workingFileId: "book",
        formulaErrors: 2,
      }),
    ]);
  });

  it.each(["complete", "error", "aborted"] as const)(
    "clears unfinished writing on %s",
    (status) => {
      const { result, source } = renderStream();
      act(() =>
        source.emit("chunk", {
          seq: 1,
          kind: "writing",
          delta: JSON.stringify({
            v: 1,
            id: "edit-1",
            name: "edit_presentation",
            textOffset: 0,
            turnIndex: 0,
          }),
        }),
      );
      expect(result.current.tools).toHaveLength(1);
      act(() => source.emit("done", { status }));
      expect(result.current.tools).toEqual([]);
      expect(result.current.status).toBe(status);
    },
  );
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
        name: outcome === "read" ? "read_chat_document" : "edit_document",
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
    expect(result.current.live.lastSeq).toBe(2);
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
    expect(result.current.live.lastSeq).toBe(1);
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
    expect(result.current.live.lastSeq).toBe(1);
    rerender({ runId: "run-2" });
    const current = FakeEventSource.instances.at(-1)!;
    expect(current.url).toContain("after=0&runId=run-2");
    expect(result.current.live.lastSeq).toBe(0);
    // A retry must never flash the previous generation's words.
    expect(result.current.live.getSnapshot().text).toBe("");
    act(() => {
      old.emit("chunk", { runId: "run-1", seq: 2, delta: "Late text" });
      old.emit("done", { runId: "run-1", status: "error" });
      current.emit("chunk", { runId: "run-2", seq: 1, delta: "New text" });
    });
    expect(result.current.live.lastSeq).toBe(1);
    expect(result.current.status).toBe("streaming");
    act(() => vi.advanceTimersByTime(500));
    expect(result.current.live.getSnapshot().text).toBe("New text");
  });

  it("reconciles a terminal detail refresh when the SSE terminal event is missing", () => {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(
      ({ status, runId }) => useMessageStream("m1", null, "c1", 0, runId, status),
      {
        wrapper,
        initialProps: {
          status: "streaming" as "streaming" | "error",
          runId: "run-1",
        },
      },
    );
    const old = FakeEventSource.instances.at(-1)!;
    rerender({ status: "error", runId: "run-1" });
    expect(old.close).toHaveBeenCalled();
    expect(result.current.status).toBe("error");
    act(() => old.emit("chunk", { runId: "run-1", seq: 1, delta: "Late" }));
    expect(result.current.live.lastSeq).toBe(0);
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
    expect(result.current.live.lastSeq).toBe(0);
  });
});

describe("resumed answer", () => {
  it("continues from the kept chunks without repeating them or a dead writing marker", () => {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const kept = {
      text: "Half an answer. ",
      reasoning: "",
      reasoningSeen: false,
      tools: [],
      compactions: [],
      lastSeq: 3,
    };
    const { result } = renderHook(() => useMessageStream("m1", kept, "c1", 1, "run-2"), {
      wrapper,
    });
    const source = FakeEventSource.instances.at(-1)!;
    expect(source.url).toContain("after=3&runId=run-2");
    const writing = (runId: string, id: string) =>
      JSON.stringify({ v: 1, id, name: "edit_presentation", textOffset: 0, turnIndex: 0, runId });
    act(() => {
      // Replay labels every stored chunk with the current attempt.
      source.emit("chunk", { runId: "run-2", seq: 3, delta: "Half an answer. " });
      source.emit("chunk", {
        runId: "run-2",
        seq: 4,
        kind: "writing",
        delta: writing("run-1", "a"),
      });
      source.emit("chunk", { runId: "run-2", seq: 5, delta: "The rest." });
    });
    expect(result.current.tools).toEqual([]);
    act(() =>
      source.emit("chunk", {
        runId: "run-2",
        seq: 6,
        kind: "writing",
        delta: writing("run-2", "b"),
      }),
    );
    expect(result.current.tools).toMatchObject([{ callId: "writing:b", writing: true }]);
    expect(result.current.live.lastSeq).toBe(6);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.live.getSnapshot().text).toBe("Half an answer. The rest.");
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
    expect(result.current.live.getSnapshot().text).not.toBe("A final chunk of several words");
    expect(invalidate).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(30 * 12));

    expect(result.current.live.getSnapshot().text).toBe("A final chunk of several words");
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
    expect(result.current.live.lastSeq).toBe(2);
    expect(result.current.live.getSnapshot().text.length).toBeLessThan(
      "Many words arriving all at once here".length,
    );
  });

  it("streams text without re-rendering its consumer", () => {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    let renders = 0;
    const { result } = renderHook(
      () => {
        renders += 1;
        return useMessageStream("m1", null, "c1");
      },
      { wrapper },
    );
    const source = FakeEventSource.instances.at(-1)!;
    const settled = renders;

    // The chat view owns this hook, so every render here is a render of the
    // whole conversation. Chunks and pacing ticks must reach the row only.
    for (let seq = 1; seq <= 20; seq += 1)
      act(() => source.emit("chunk", { seq, delta: `word${seq} ` }));
    act(() => source.emit("chunk", { seq: 21, kind: "reasoning", delta: "thinking" }));
    act(() => vi.advanceTimersByTime(30 * 40));

    expect(result.current.live.getSnapshot()).toMatchObject({ drained: true, reasoningSeen: true });
    expect(result.current.live.getSnapshot().text).toContain("word20");
    expect(renders).toBe(settled);
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
  it("deduplicates ref-only file chunks and clears them for same-message retries", () => {
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
        kind: "file",
        delta: JSON.stringify(image),
      });
      old.emit("chunk", {
        runId: "generation-1",
        seq: 2,
        kind: "file",
        delta: JSON.stringify(image),
      });
    });
    expect(result.current.files).toEqual([image]);
    expect(result.current.live.getSnapshot().text).toBe("");
    act(() => old.emit("done", { runId: "generation-1", status: "complete" }));
    expect(result.current.status).toBe("complete");
    rerender({ runId: "generation-2" });
    expect(result.current.files).toEqual([]);
    act(() =>
      old.emit("chunk", {
        runId: "generation-1",
        seq: 3,
        kind: "file",
        delta: JSON.stringify(image),
      }),
    );
    expect(result.current.files).toEqual([]);
    expect(result.current.live.lastSeq).toBe(0);
  });
});
