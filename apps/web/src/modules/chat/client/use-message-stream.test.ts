import { describe, expect, it } from "vitest";
import {
  applySteerChunk,
  applyCompactionChunk,
  applyToolActivityChunk,
  applyToolChunk,
  learnServerClock,
  serverNow,
  type CompactionActivity,
  type ToolActivity,
} from "./use-message-stream.ts";

const env = (value: Record<string, unknown>) => JSON.stringify({ v: 1, ...value });

const start = env({
  family: "web",
  phase: "start",
  callId: "c1",
  name: "web_search",
  turnIndex: 0,
  callIndex: 0,
  args: { targets: ["effect ts", "effect schema"] },
});

describe("activity text offsets", () => {
  it.each(["web", "memory", "ask"] as const)(
    "preserves the %s start offset across progress, results and replay",
    (family) => {
      const name =
        family === "web" ? "web_search" : family === "memory" ? "save_memory" : "ask_user";
      const begin = env({
        phase: "start",
        family,
        name,
        callId: "offset",
        turnIndex: 1,
        callIndex: 2,
        textOffset: 8,
      });
      const finish = env({
        phase: "result",
        family,
        name,
        callId: "offset",
        textOffset: 99,
        ok: true,
        outcome: "created",
        summary: { targets: [] },
        result: {
          v: 1,
          outcome: "presented",
          questions: [{ question: "Why?", multiSelect: false, options: [] }],
        },
      });
      let activities = applyToolChunk([], begin);
      activities = applyToolChunk(
        activities,
        env({
          phase: "progress",
          family,
          name,
          callId: "offset",
          textOffset: 55,
          summary: { targets: [] },
        }),
      );
      expect(activities[0]?.textOffset).toBe(8);
      const complete = applyToolChunk(activities, finish);
      expect(complete[0]).toMatchObject({ textOffset: 8, status: "complete" });
      expect(applyToolChunk(complete, begin)).toBe(complete);
      expect(
        applyToolChunk(complete, env({ phase: "progress", family, name, callId: "offset" })),
      ).toBe(complete);
      expect(applyToolChunk([], finish)[0]).not.toHaveProperty("textOffset");
    },
  );

  it.each([-1, 0.5, "8", null])("does not accept malformed start offsets %j", (textOffset) => {
    const activity = applyToolChunk(
      [],
      env({ family: "web", phase: "start", name: "web_search", callId: "invalid", textOffset }),
    )[0];
    expect(activity).not.toHaveProperty("textOffset");
  });

  it("retains the original compaction anchor, including explicit result-only anchors", () => {
    const position = {
      eventId: "compact",
      beforeTurnIndex: 1,
      passIndex: 0,
      scope: "active_rounds",
    };
    const started = applyCompactionChunk([], env({ ...position, phase: "start", textOffset: 12 }));
    const complete = applyCompactionChunk(
      started,
      env({ ...position, phase: "result", textOffset: 99, ok: true }),
    );
    expect(complete[0]?.textOffset).toBe(12);
    expect(
      applyCompactionChunk([], env({ ...position, phase: "result", textOffset: 12, ok: true }))[0]
        ?.textOffset,
    ).toBe(12);
    expect(
      applyCompactionChunk([], env({ ...position, phase: "result", ok: true }))[0],
    ).not.toHaveProperty("textOffset");
    expect(
      applyCompactionChunk(complete, env({ ...position, phase: "start", textOffset: 99 })),
    ).toBe(complete);
  });
});

describe("ask_user replay", () => {
  const questions = [
    { question: "Which approach?", multiSelect: false, options: [{ label: "A" }, { label: "B" }] },
  ];
  const askStart = env({
    family: "ask",
    phase: "start",
    callId: "ask-1",
    name: "ask_user",
    turnIndex: 2,
    callIndex: 1,
  });
  const result = (value: unknown) =>
    env({ family: "ask", phase: "result", callId: "ask-1", name: "ask_user", result: value });

  it("preserves position through result replay and ignores late starts", () => {
    const running = applyToolChunk([], askStart);
    expect(running[0]).toMatchObject({
      family: "ask",
      status: "running",
      turnIndex: 2,
      callIndex: 1,
    });
    const complete = applyToolChunk(running, result({ v: 1, outcome: "presented", questions }));
    expect(complete).toEqual([
      {
        family: "ask",
        callId: "ask-1",
        name: "ask_user",
        status: "complete",
        turnIndex: 2,
        callIndex: 1,
        questions,
      },
    ]);
    expect(applyToolChunk(complete, result({ v: 1, outcome: "presented", questions }))).toEqual(
      complete,
    );
    expect(applyToolChunk(complete, askStart)).toBe(complete);
    expect(applyToolChunk(complete, result(null))).toBe(complete);
  });

  it.each([
    { v: 1, outcome: "rejected", message: "Already presented" },
    { v: 2, outcome: "presented", questions },
    { v: 1, outcome: "presented", questions: [] },
    null,
  ])("does not turn rejected or malformed results into actionable questions: %j", (value) => {
    expect(applyToolChunk([], result(value))[0]).toMatchObject({ family: "ask", status: "error" });
    expect(applyToolChunk([], result(value))[0]).not.toHaveProperty("questions");
  });

  it("ignores primitive envelopes and unrelated family collisions", () => {
    expect(applyToolChunk([], "null")).toEqual([]);
    const web = applyToolChunk([], start);
    expect(applyToolChunk([], start, "ask")).toEqual([]);
    expect(
      applyToolChunk(web, env({ family: "ask", phase: "start", callId: "c1", name: "ask_user" })),
    ).toBe(web);
  });
});

describe("applyToolChunk", () => {
  it("projects publication start, success and failure without exposing file bytes", () => {
    const publishStart = env({
      family: "tool-file",
      phase: "start",
      name: "publish_file",
      callId: "publish-1",
      turnIndex: 2,
      callIndex: 1,
      textOffset: 12,
    });
    const pending = applyToolChunk([], publishStart);
    expect(pending[0]).toMatchObject({ family: "tool-file", status: "running", textOffset: 12 });
    const ready = applyToolChunk(
      pending,
      env({
        family: "tool-file",
        phase: "result",
        name: "publish_file",
        callId: "publish-1",
        ok: true,
        attachmentId: "attachment-1",
      }),
    );
    expect(ready[0]).toMatchObject({ status: "complete", attachmentId: "attachment-1" });
    expect(applyToolChunk(ready, publishStart)).toBe(ready);
    const failed = applyToolChunk(
      [],
      env({
        family: "tool-file",
        phase: "result",
        name: "publish_file",
        callId: "publish-2",
        ok: false,
        error: "File limit reached.",
      }),
    );
    expect(failed[0]).toMatchObject({
      family: "tool-file",
      status: "error",
      error: "File limit reached.",
    });
  });

  it("projects a presentation step's summary and keeps its call identity", () => {
    const running = applyToolChunk(
      [],
      env({
        family: "presentation",
        phase: "start",
        name: "edit_presentation",
        callId: "deck-1",
        turnIndex: 0,
        callIndex: 0,
        textOffset: 0,
      }),
    );
    const done = applyToolChunk(
      running,
      env({
        family: "presentation",
        phase: "result",
        name: "edit_presentation",
        callId: "deck-1",
        outcome: "working",
        message: "Private draft updated.",
        workingFileId: "draft",
        revision: 1,
        origin: "created",
        changes: "Added a slide",
        slideCount: 2,
        renderedSlideIds: [256],
      }),
    );
    expect(done[0]).toMatchObject({
      family: "presentation",
      callId: "deck-1",
      name: "edit_presentation",
      status: "complete",
      origin: "created",
      changes: "Added a slide",
      slideCount: 2,
      renderedSlideIds: [256],
    });
    expect(done[0]).not.toHaveProperty("v");
    const failed = applyToolChunk(
      [],
      env({
        family: "presentation",
        phase: "result",
        name: "edit_presentation",
        callId: "deck-2",
        outcome: "error",
        message: "invalid_operation: operations[0] addText: missing x",
      }),
    );
    expect(failed[0]).toMatchObject({
      status: "error",
      error: "invalid_operation: operations[0] addText: missing x",
    });
  });

  it("creates a running activity from a start envelope", () => {
    expect(applyToolChunk([], start)).toEqual([
      {
        family: "web",
        callId: "c1",
        name: "web_search",
        turnIndex: 0,
        callIndex: 0,
        targets: ["effect ts", "effect schema"],
        status: "running",
      },
    ]);
  });

  it("ignores a duplicate start for the same call", () => {
    const once = applyToolChunk([], start);
    expect(applyToolChunk(once, start)).toBe(once);
  });

  it("applies reader progress envelopes as per-page status transitions", () => {
    let tools = applyToolChunk(
      [],
      env({
        phase: "start",
        callId: "c1",
        name: "read_url",
        family: "web",
        args: { targets: ["https://a.dev/x", "https://b.dev/y"] },
      }),
    );

    tools = applyToolChunk(
      tools,
      env({
        phase: "progress",
        callId: "c1",
        name: "read_url",
        family: "web",
        summary: { targets: ["https://a.dev/x", "https://b.dev/y"], resultCount: 0 },
        pages: [
          { url: "https://a.dev/x", title: "A", status: "reading" },
          { url: "https://b.dev/y", status: "pending" },
        ],
      }),
    );

    expect(tools[0]).toMatchObject({ family: "web", status: "running", resultCount: 0 });
    const activity = tools[0];
    expect(activity?.family).toBe("web");
    if (!activity || activity.family !== "web") throw new Error("expected web activity");
    expect(activity.pages?.map((page) => page.status)).toEqual(["reading", "pending"]);
    expect(tools).toHaveLength(1);
  });

  it("keeps known targets when progress omits them", () => {
    let tools = applyToolChunk([], start);
    tools = applyToolChunk(
      tools,
      env({
        phase: "progress",
        family: "web",
        callId: "c1",
        name: "web_search",
        summary: {},
        pages: [],
      }),
    );
    const activity = tools[0];
    expect(activity?.family).toBe("web");
    if (!activity || activity.family !== "web") throw new Error("expected web activity");
    expect(activity.targets).toEqual(["effect ts", "effect schema"]);
  });

  it("finalizes on a result envelope", () => {
    const tools = applyToolChunk(
      applyToolChunk([], start),
      env({
        phase: "result",
        family: "web",
        callId: "c1",
        name: "web_search",
        ok: true,
        summary: {
          targets: ["effect ts", "effect schema"],
          resultCount: 5,
          pagesFetched: 0,
        },
        sources: [
          {
            kind: "web" as const,
            index: 1,
            url: "https://a.dev/x",
            title: "A",
            snippet: "A result",
            read: false,
          },
        ],
      }),
    );

    expect(tools).toEqual<ToolActivity[]>([
      {
        family: "web",
        callId: "c1",
        name: "web_search",
        turnIndex: 0,
        callIndex: 0,
        targets: ["effect ts", "effect schema"],
        status: "complete",
        resultCount: 5,
        pagesFetched: 0,
        sources: [
          {
            kind: "web" as const,
            index: 1,
            url: "https://a.dev/x",
            title: "A",
            snippet: "A result",
            read: false,
          },
        ],
      },
    ]);
  });

  it("marks a failed result as error with its message", () => {
    const tools = applyToolChunk(
      [],
      env({
        phase: "result",
        family: "web",
        callId: "c1",
        name: "web_search",
        ok: false,
        summary: { targets: ["q"] },
        error: "searxng unreachable",
      }),
    );
    expect(tools[0]).toMatchObject({ status: "error", error: "searxng unreachable" });
  });

  it("upserts summary-only memory activity without retaining arguments", () => {
    const memoryStart = env({
      family: "memory",
      phase: "start",
      callId: "memory-1",
      name: "save_memory",
      turnIndex: 1,
      callIndex: 2,
      args: { content: "never retain this" },
    });
    const memoryResult = env({
      family: "memory",
      phase: "result",
      callId: "memory-1",
      name: "save_memory",
      ok: true,
      outcome: "created",
    });

    const running = applyToolChunk([], memoryStart);
    const complete = applyToolChunk(running, memoryResult);
    const replayed = applyToolChunk(complete, memoryResult);

    expect(running).toEqual([
      {
        family: "memory",
        callId: "memory-1",
        name: "save_memory",
        turnIndex: 1,
        callIndex: 2,
        status: "running",
      },
    ]);
    expect(complete).toEqual([
      {
        family: "memory",
        callId: "memory-1",
        name: "save_memory",
        turnIndex: 1,
        callIndex: 2,
        status: "complete",
        outcome: "created",
      },
    ]);
    expect(replayed).toEqual(complete);
    expect(replayed).toHaveLength(1);
  });

  it.each(["web_search", "read_url", "save_memory"])(
    "rejects %s envelopes without a family",
    (name) => {
      const tools = applyToolChunk([], start);
      expect(applyToolChunk(tools, env({ phase: "start", callId: "missing-family", name }))).toBe(
        tools,
      );
    },
  );

  it("ignores malformed or unversioned envelopes", () => {
    const seed: ToolActivity[] = [
      { family: "web", callId: "c1", name: "web_search", targets: ["q"], status: "running" },
    ];
    expect(applyToolChunk(seed, "not json")).toBe(seed);
    expect(applyToolChunk(seed, env({ phase: "start", name: "web_search" }))).toBe(seed);
    expect(applyToolChunk(seed, JSON.stringify({ v: 99, phase: "start", callId: "c2" }))).toBe(
      seed,
    );
    expect(applyToolChunk(seed, env({ phase: "who-knows", callId: "c1", name: "x" }))).toBe(seed);
  });
});

describe("applyCompactionChunk", () => {
  const compaction = (value: Record<string, unknown>) =>
    env({
      eventId: "compact-1",
      beforeTurnIndex: 1,
      passIndex: 0,
      scope: "active_rounds",
      ...value,
    });

  it("upserts a stable event and carries its summary through the result", () => {
    const running = applyCompactionChunk([], compaction({ phase: "start" }));
    expect(running).toEqual([
      {
        eventId: "compact-1",
        beforeTurnIndex: 1,
        passIndex: 0,
        scope: "active_rounds",
        status: "running",
      },
    ]);

    expect(
      applyCompactionChunk(
        running,
        compaction({ phase: "result", ok: true, outcome: "summary", summary: "Older turns." }),
      ),
    ).toEqual([
      {
        eventId: "compact-1",
        beforeTurnIndex: 1,
        passIndex: 0,
        scope: "active_rounds",
        status: "complete",
        outcome: "summary",
        summary: "Older turns.",
      },
    ]);
  });

  it("retains multiple events in chronological turn/pass order", () => {
    const later = applyCompactionChunk(
      [],
      env({
        phase: "start",
        eventId: "later",
        beforeTurnIndex: 2,
        passIndex: 0,
        scope: "active_rounds",
      }),
    );
    const ordered = applyCompactionChunk(
      later,
      env({
        phase: "result",
        eventId: "earlier",
        beforeTurnIndex: 0,
        passIndex: 0,
        scope: "history",
        ok: true,
        outcome: "hard_truncation",
      }),
    );
    expect(ordered.map((event) => event.eventId)).toEqual(["earlier", "later"]);
  });

  it("does not regress a terminal event on a replayed start", () => {
    const complete = applyCompactionChunk(
      [],
      compaction({ phase: "result", ok: true, outcome: "summary", summary: "done" }),
    );
    expect(applyCompactionChunk(complete, compaction({ phase: "start" }))).toBe(complete);
  });

  it("ignores malformed or unversioned envelopes", () => {
    const seed: CompactionActivity[] = [
      {
        eventId: "compact-1",
        beforeTurnIndex: 1,
        passIndex: 0,
        scope: "active_rounds",
        status: "running",
      },
    ];
    expect(applyCompactionChunk(seed, "not json")).toBe(seed);
    expect(applyCompactionChunk(seed, JSON.stringify({ v: 99, phase: "result" }))).toBe(seed);
    expect(applyCompactionChunk(seed, env({ phase: "who-knows" }))).toBe(seed);
  });
});

const steerEnvelope = (id: string) =>
  JSON.stringify({
    v: 1,
    id,
    queueEntryId: `entry-${id}`,
    content: "make it shorter",
    textOffset: 12,
    turnIndex: 0,
    attachments: [],
  });

describe("applySteerChunk", () => {
  it("adds a steer once, keeping the order the answer took them in", () => {
    const once = applySteerChunk([], steerEnvelope("a"));
    const twice = applySteerChunk(applySteerChunk(once, steerEnvelope("b")), steerEnvelope("a"));
    expect(twice.map((steer) => [steer.id, steer.queueEntryId, steer.textOffset])).toEqual([
      ["a", "entry-a", 12],
      ["b", "entry-b", 12],
    ]);
  });

  it("ignores an envelope it cannot read", () => {
    expect(applySteerChunk([], "{not json")).toEqual([]);
    expect(applySteerChunk([], JSON.stringify({ v: 2, id: "x" }))).toEqual([]);
  });
});

// Creation, replacement by the started call and clearing on done are covered
// through the hook in use-message-stream.test.tsx; these are the edge cases.
describe("a deck edit still being written", () => {
  const writing = (id: string) =>
    JSON.stringify({ v: 1, id, name: "edit_presentation", textOffset: 4, turnIndex: 2 });

  it("keeps one placeholder, and only a call starting removes it", () => {
    let tools = applyToolActivityChunk([], "writing", writing("a"));
    tools = applyToolActivityChunk(tools, "writing", writing("b"));
    expect(tools.map((tool) => tool.callId)).toEqual(["writing:b"]);
    tools = applyToolActivityChunk(
      tools,
      "tool",
      env({ family: "presentation", phase: "result", callId: "old", name: "inspect_presentation" }),
    );
    expect(tools.some((tool) => tool.callId === "writing:b")).toBe(true);
  });

  it("stands in for a research brief being written, until the run starts", () => {
    let tools = applyToolActivityChunk(
      [],
      "writing",
      JSON.stringify({ v: 1, id: "r", name: "deep_research", textOffset: 12, turnIndex: 0 }),
    );
    expect(tools).toEqual([
      expect.objectContaining({ family: "research", writing: true, textOffset: 12 }),
    ]);
    tools = applyToolActivityChunk(
      tools,
      "tool",
      env({
        family: "research",
        phase: "start",
        name: "deep_research",
        callId: "row-1",
        runId: "run-1",
        turnIndex: 0,
        callIndex: 0,
        textOffset: 12,
        progress: {
          runId: "run-1",
          phase: "queued",
          tasks: [],
          limitations: [],
          usageComplete: false,
        },
      }),
    );
    expect(tools.map((tool) => tool.callId)).toEqual(["row-1"]);
  });

  it("shows a document edit as running while its text streams into the panel", () => {
    expect(
      applyToolActivityChunk(
        [],
        "writing",
        JSON.stringify({ v: 1, id: "x", name: "edit_document", textOffset: 4, turnIndex: 0 }),
      ),
    ).toMatchObject([
      { family: "document", name: "edit_document", status: "running", callId: "writing:x" },
    ]);
  });

  it("ignores markers for other tools and malformed ones", () => {
    expect(
      applyToolActivityChunk(
        [],
        "writing",
        JSON.stringify({ v: 1, id: "x", name: "web_search", textOffset: 0, turnIndex: 0 }),
      ),
    ).toEqual([]);
    expect(applyToolActivityChunk([], "writing", "{")).toEqual([]);
  });
});

describe("a replayed call's timing", () => {
  it("is stamped with the time its chunk was written, not when a reload replays it", () => {
    const written = Date.now() - 40_000;
    const tools = applyToolActivityChunk([], "tool", start, written);
    expect(tools[0]).toMatchObject({ callId: "c1", startedAt: written });
    expect(tools[0]).not.toHaveProperty("completedAt");
  });
});

describe("the server's clock", () => {
  it("reads elapsed time against the server, whatever the browser's clock says", () => {
    const local = Date.now();
    // The server runs a minute behind this browser.
    learnServerClock(local - 60_000, local);
    expect(Math.abs(serverNow() - (Date.now() - 60_000))).toBeLessThan(1000);
    learnServerClock(Date.now());
    expect(Math.abs(serverNow() - Date.now())).toBeLessThan(1000);
  });
});
