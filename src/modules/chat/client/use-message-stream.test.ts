import { describe, expect, it } from "vitest";
import { applyToolChunk, type ToolActivity } from "./use-message-stream.ts";

const env = (o: Record<string, unknown>) => JSON.stringify({ v: 1, ...o });

describe("applyToolChunk", () => {
  it("creates a running activity from a start envelope", () => {
    const tools = applyToolChunk(
      [],
      env({ phase: "start", callId: "c1", name: "web_search", args: { query: "effect ts" } }),
    );
    expect(tools).toEqual([
      { callId: "c1", name: "web_search", query: "effect ts", status: "running" },
    ]);
  });

  it("ignores a duplicate start for the same call", () => {
    const start = env({ phase: "start", callId: "c1", name: "web_search", args: { query: "q" } });
    const once = applyToolChunk([], start);
    expect(applyToolChunk(once, start)).toBe(once);
  });

  it("applies progress envelopes as per-page status transitions", () => {
    let tools = applyToolChunk(
      [],
      env({ phase: "start", callId: "c1", name: "web_search", args: { query: "q" } }),
    );

    // Search finished: hit count known, pages queued.
    tools = applyToolChunk(
      tools,
      env({
        phase: "progress",
        callId: "c1",
        name: "web_search",
        summary: { query: "q", resultCount: 5 },
        pages: [
          { url: "https://a.dev/x", title: "A", status: "pending" },
          { url: "https://b.dev/y", status: "pending" },
        ],
      }),
    );
    expect(tools[0]).toMatchObject({ status: "running", resultCount: 5 });
    expect(tools[0]!.pages).toHaveLength(2);

    // First page starts reading.
    tools = applyToolChunk(
      tools,
      env({
        phase: "progress",
        callId: "c1",
        name: "web_search",
        summary: { query: "q", resultCount: 5 },
        pages: [
          { url: "https://a.dev/x", title: "A", status: "reading" },
          { url: "https://b.dev/y", status: "pending" },
        ],
      }),
    );
    expect(tools[0]!.pages?.map((p) => p.status)).toEqual(["reading", "pending"]);
    expect(tools).toHaveLength(1); // upserted, not appended
  });

  it("does not resurrect a query already known when progress omits it", () => {
    let tools = applyToolChunk(
      [],
      env({ phase: "start", callId: "c1", name: "web_search", args: { query: "keep me" } }),
    );
    tools = applyToolChunk(
      tools,
      env({ phase: "progress", callId: "c1", name: "web_search", summary: {}, pages: [] }),
    );
    expect(tools[0]!.query).toBe("keep me");
  });

  it("finalizes on a result envelope", () => {
    let tools = applyToolChunk(
      [],
      env({ phase: "start", callId: "c1", name: "web_search", args: { query: "q" } }),
    );
    tools = applyToolChunk(
      tools,
      env({
        phase: "result",
        callId: "c1",
        name: "web_search",
        ok: true,
        summary: { query: "q", resultCount: 5, pagesFetched: 2 },
        pages: [{ url: "https://a.dev/x", title: "A", status: "done" }],
      }),
    );
    expect(tools).toEqual<ToolActivity[]>([
      {
        callId: "c1",
        name: "web_search",
        query: "q",
        status: "complete",
        resultCount: 5,
        pagesFetched: 2,
        pages: [{ url: "https://a.dev/x", title: "A", status: "done" }],
      },
    ]);
  });

  it("marks a failed result as error with its message", () => {
    const tools = applyToolChunk(
      [],
      env({
        phase: "result",
        callId: "c1",
        name: "web_search",
        ok: false,
        summary: { query: "q" },
        error: "searxng unreachable",
      }),
    );
    expect(tools[0]).toMatchObject({ status: "error", error: "searxng unreachable" });
  });

  it("ignores malformed or unversioned envelopes", () => {
    const seed: ToolActivity[] = [
      { callId: "c1", name: "web_search", query: "q", status: "running" },
    ];
    expect(applyToolChunk(seed, "not json")).toBe(seed);
    expect(applyToolChunk(seed, env({ phase: "start", name: "web_search" }))).toBe(seed);
    expect(applyToolChunk(seed, JSON.stringify({ v: 99, phase: "start", callId: "c2" }))).toBe(
      seed,
    );
    expect(applyToolChunk(seed, env({ phase: "who-knows", callId: "c1", name: "x" }))).toBe(seed);
  });
});
