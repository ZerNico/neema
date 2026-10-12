import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyDoc, type SheetDoc } from "@chat/sheet/model";
import type { SheetChange, SheetOp } from "@chat/sheet/model/ops";
import { applyChange } from "@chat/sheet/model/apply";
import { parseFormula } from "@chat/sheet/model/formula";
import type { PushSheetAnswer, PushSheetInput, SheetFrame } from "../schema.ts";
import { SheetSync, type SheetFeedSource, type SheetOutbox } from "./sheet-sync.ts";

const moment = { now: 45_000, seed: 1 };
const write = (r: string, c: string, v: string): SheetOp => ({
  op: "set",
  sh: "s1",
  cells: [{ r, c, v }],
});
const valueAt = (doc: SheetDoc | null, r: string, c: string) => doc?.sheet.s1!.cells[r]?.[c]?.v;

/** A sheet connection with a feed the test drives and a push it answers. */
function connection(outbox?: SheetOutbox) {
  const listeners = new Map<string, (event: MessageEvent<string>) => void>();
  const source: SheetFeedSource = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    close: () => {},
  };
  const pushes: PushSheetInput[] = [];
  let answer: (input: PushSheetInput) => PushSheetAnswer = (input) => ({
    revision: 0,
    acked: Math.max(
      0,
      ...(input.changes ?? []).map((each) => (JSON.parse(each) as SheetChange).seq),
    ),
    refused: [],
  });
  const sync = new SheetSync({
    documentId: "sheet-1",
    clientId: "me",
    connect: () => source,
    ...(outbox ? { outbox } : {}),
    push: async (input) => {
      pushes.push(input);
      return answer(input);
    },
  });
  const feed = (frame: SheetFrame) =>
    listeners.get(frame.type)!(new MessageEvent(frame.type, { data: JSON.stringify(frame) }));
  return {
    sync,
    pushes,
    feed,
    answerWith: (next: typeof answer) => {
      answer = next;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a sheet's connection", () => {
  it("shows an edit at once, sends it, and lets it go once acknowledged", async () => {
    const { sync, pushes, feed } = connection();
    feed({ type: "reset", doc: emptyDoc(), revision: 0, moment, acked: null });
    sync.dispatch([write("s1.r1", "s1.c1", "mine")]);
    expect(valueAt(sync.getState().doc, "s1.r1", "s1.c1")).toBe("mine");
    expect(sync.getState().pending).toBe(1);
    await vi.runAllTimersAsync();
    expect(pushes).toHaveLength(1);
    expect(JSON.parse(pushes[0]!.changes![0]!)).toMatchObject({ clientId: "me", seq: 1 });
    expect(sync.getState().pending).toBe(0);
  });

  it("reports a dropped sort while keeping unrelated pending operations and its live feed", async () => {
    const { sync, feed, pushes, answerWith } = connection();
    const initial = emptyDoc();
    const parsed = parseFormula("A1000+A1", { doc: initial, sheet: "s1" });
    if (!("formula" in parsed)) throw new Error("unparsed");
    const doc = applyChange(
      initial,
      {
        clientId: "setup",
        seq: 1,
        ops: [
          {
            op: "set",
            sh: "s1",
            cells: [
              { r: "s1.r1", c: "s1.c1", v: 30 },
              { r: "s1.r2", c: "s1.c1", v: 10 },
              { r: "s1.r1", c: "s1.c2", f: parsed.formula },
            ],
          },
        ],
      },
      1,
    ).doc;
    feed({ type: "reset", doc, revision: 1, moment, acked: null });
    const ops: SheetOp[] = [
      write("s1.r4", "s1.c4", "before"),
      {
        op: "sort",
        sh: "s1",
        c1: "s1.c1",
        c2: "s1.c2",
        rows: ["s1.r1", "s1.r2"],
        order: ["s1.r2", "s1.r1"],
      },
      write("s1.r5", "s1.c4", "after"),
    ];
    sync.dispatch(ops);
    expect(sync.getState()).toMatchObject({
      status: "live",
      pending: 1,
      refused:
        "Some changes weren’t kept: a sort whose shifted formulas need more rows or columns.",
    });
    expect(["s1.r1", "s1.r2"].map((r) => valueAt(sync.getState().doc, r, "s1.c1"))).toEqual([
      30, 10,
    ]);
    expect(valueAt(sync.getState().doc, "s1.r4", "s1.c4")).toBe("before");
    expect(valueAt(sync.getState().doc, "s1.r5", "s1.c4")).toBe("after");
    feed({
      type: "changes",
      changes: [{ clientId: "other", seq: 1, ops: [write("s1.r6", "s1.c4", "theirs")] }],
      revision: 2,
      moment,
    });
    expect(sync.getState().status).toBe("live");
    expect(valueAt(sync.getState().doc, "s1.r6", "s1.c4")).toBe("theirs");
    answerWith(() => ({ revision: 3, acked: 1, refused: [] }));
    await sync.flush();
    expect(pushes).toHaveLength(1);
    expect(sync.getState().pending).toBe(0);
    feed({ type: "changes", changes: [{ clientId: "me", seq: 1, ops }], revision: 3, moment });
    expect(valueAt(sync.getState().doc, "s1.r4", "s1.c4")).toBe("before");
    expect(valueAt(sync.getState().doc, "s1.r5", "s1.c4")).toBe("after");
    expect(sync.getState().refused).toContain("shifted formulas");
    sync.destroy();
  });

  it("reports an optimistic sort refused only when its feed batch brings a prior deletion", () => {
    const { sync, feed } = connection();
    const initial = emptyDoc();
    const parsed = parseFormula("A999+A1", { doc: initial, sheet: "s1" });
    if (!("formula" in parsed)) throw new Error("unparsed");
    const doc = applyChange(
      initial,
      {
        clientId: "setup",
        seq: 1,
        ops: [
          {
            op: "set",
            sh: "s1",
            cells: [
              { r: "s1.r1", c: "s1.c1", v: 30 },
              { r: "s1.r2", c: "s1.c1", v: 10 },
              { r: "s1.r1", c: "s1.c2", f: parsed.formula },
            ],
          },
        ],
      },
      1,
    ).doc;
    feed({ type: "reset", doc, revision: 1, moment, acked: null });
    const ops: SheetOp[] = [
      {
        op: "sort",
        sh: "s1",
        c1: "s1.c1",
        c2: "s1.c2",
        rows: ["s1.r1", "s1.r2"],
        order: ["s1.r2", "s1.r1"],
      },
      write("s1.r4", "s1.c4", "kept"),
    ];
    sync.dispatch(ops);
    expect(valueAt(sync.getState().doc, "s1.r1", "s1.c1")).toBe(10);
    expect(sync.getState().refused).toBeNull();
    feed({
      type: "changes",
      changes: [
        {
          clientId: "other",
          seq: 1,
          ops: [{ op: "delete", sh: "s1", axis: "rows", ids: ["s1.r1000"] }],
        },
        { clientId: "me", seq: 1, ops },
      ],
      revision: 3,
      moment,
    });
    expect(sync.getState()).toMatchObject({
      status: "live",
      pending: 0,
      refused:
        "Some changes weren’t kept: a sort whose shifted formulas need more rows or columns.",
    });
    expect(["s1.r1", "s1.r2"].map((r) => valueAt(sync.getState().doc, r, "s1.c1"))).toEqual([
      30, 10,
    ]);
    expect(valueAt(sync.getState().doc, "s1.r4", "s1.c4")).toBe("kept");
    sync.destroy();
  });

  it("keeps showing an acknowledged edit until the feed brings it, never flashing back", async () => {
    const { sync, feed, answerWith } = connection();
    // The server has the edit at revision 1 before its feed says so.
    answerWith(() => ({ revision: 1, acked: 1, refused: [] }));
    feed({ type: "reset", doc: emptyDoc(), revision: 0, moment, acked: null });
    sync.dispatch([write("s1.r1", "s1.c1", "mine")]);
    await vi.runAllTimersAsync();
    expect(sync.getState().pending).toBe(0);
    expect(valueAt(sync.getState().doc, "s1.r1", "s1.c1")).toBe("mine");
    feed({
      type: "changes",
      changes: [{ clientId: "me", seq: 1, ops: [write("s1.r1", "s1.c1", "mine")] }],
      revision: 1,
      moment,
    });
    expect(valueAt(sync.getState().doc, "s1.r1", "s1.c1")).toBe("mine");
    // A refused edit will never be in the feed, so it goes as soon as the answer says so.
    answerWith(() => ({ revision: 2, acked: 2, refused: [{ seq: 2, reason: "no" }] }));
    sync.dispatch([write("s1.r2", "s1.c1", "refused")]);
    await vi.runAllTimersAsync();
    expect(valueAt(sync.getState().doc, "s1.r2", "s1.c1")).toBeUndefined();
    expect(sync.getState().refused).toBe("Some changes weren’t kept: no.");
  });

  it("keeps every acknowledged edit shown while the feed lags, as the same document", async () => {
    const { sync, feed, answerWith } = connection();
    feed({ type: "reset", doc: emptyDoc(), revision: 0, moment, acked: null });
    answerWith(() => ({ revision: 1, acked: 1, refused: [] }));
    sync.dispatch([write("s1.r1", "s1.c1", "first")]);
    const shown = sync.getState().doc;
    await vi.runAllTimersAsync();
    // Acknowledging moves nothing on the sheet: it shows the very same document.
    expect(sync.getState().doc).toBe(shown);
    expect(sync.getState().pending).toBe(0);
    answerWith(() => ({ revision: 2, acked: 2, refused: [] }));
    sync.dispatch([write("s1.r2", "s1.c1", "second")]);
    await vi.runAllTimersAsync();
    // The feed has brought neither: both stay, the first not lost to the second's answer.
    expect(valueAt(sync.getState().doc, "s1.r1", "s1.c1")).toBe("first");
    expect(valueAt(sync.getState().doc, "s1.r2", "s1.c1")).toBe("second");
    feed({
      type: "changes",
      changes: [
        { clientId: "me", seq: 1, ops: [write("s1.r1", "s1.c1", "first")] },
        { clientId: "me", seq: 2, ops: [write("s1.r2", "s1.c1", "second")] },
      ],
      revision: 2,
      moment,
    });
    expect(valueAt(sync.getState().doc, "s1.r1", "s1.c1")).toBe("first");
    expect(sync.getState().pending).toBe(0);
  });

  it("keeps the document when the feed brings back only this tab's own edits", async () => {
    const { sync, feed, answerWith } = connection();
    feed({ type: "reset", doc: emptyDoc(), revision: 0, moment, acked: null });
    answerWith(() => ({ revision: 1, acked: 1, refused: [] }));
    sync.dispatch([write("s1.r1", "s1.c1", "mine")]);
    await vi.runAllTimersAsync();
    const shown = sync.getState().doc;
    feed({
      type: "changes",
      changes: [{ clientId: "me", seq: 1, ops: [write("s1.r1", "s1.c1", "mine")] }],
      revision: 1,
      moment: { now: 45_001, seed: 2 },
    });
    // The same sheet, so it is not copied and calculated again; the revision still moves on.
    expect(sync.getState().doc).toBe(shown);
    expect(sync.getState().revision).toBe(1);
    // Someone else's edit is a new sheet.
    feed({
      type: "changes",
      changes: [{ clientId: "other", seq: 1, ops: [write("s1.r2", "s1.c1", "theirs")] }],
      revision: 2,
      moment,
    });
    expect(sync.getState().doc).not.toBe(shown);
    expect(valueAt(sync.getState().doc, "s1.r2", "s1.c1")).toBe("theirs");
    expect(valueAt(sync.getState().doc, "s1.r1", "s1.c1")).toBe("mine");
  });

  it("drops changes the server rejects instead of sending them forever", async () => {
    const { sync, pushes, feed, answerWith } = connection();
    answerWith(() => ({ rejected: "this document is read-only for you" }));
    feed({ type: "reset", doc: emptyDoc(), revision: 0, moment, acked: null });
    sync.dispatch([write("s1.r1", "s1.c1", "one")]);
    sync.dispatch([write("s1.r2", "s1.c1", "two")]);
    await vi.runAllTimersAsync();
    expect(pushes).toHaveLength(1);
    expect(sync.getState()).toMatchObject({
      pending: 0,
      refused: "Some changes weren’t kept: this document is read-only for you.",
    });
    expect(valueAt(sync.getState().doc, "s1.r1", "s1.c1")).toBeUndefined();
    // The next edit starts a new client at 1: the server may hold some of the dropped numbers,
    // and would take a reused one as a resend it need not apply.
    answerWith(() => ({ revision: 1, acked: 1, refused: [] }));
    sync.dispatch([write("s1.r3", "s1.c1", "three")]);
    await vi.runAllTimersAsync();
    const next = JSON.parse(pushes[1]!.changes![0]!) as { clientId: string; seq: number };
    expect(next.seq).toBe(1);
    expect(next.clientId).not.toBe("me");
    expect(pushes[1]!.clientId).toBe(next.clientId);
  });

  it("replays unsent edits over what others did meanwhile", async () => {
    const { sync, feed, answerWith } = connection();
    // The push never comes back, as when the network is slow.
    answerWith(() => {
      throw new Error("offline");
    });
    feed({ type: "reset", doc: emptyDoc(), revision: 0, moment, acked: null });
    sync.dispatch([write("s1.r1", "s1.c2", "mine")]);
    feed({
      type: "changes",
      changes: [{ clientId: "them", seq: 1, ops: [write("s1.r1", "s1.c1", "theirs")] }],
      revision: 1,
      moment,
    });
    const shown = sync.getState().doc;
    expect([valueAt(shown, "s1.r1", "s1.c1"), valueAt(shown, "s1.r1", "s1.c2")]).toEqual([
      "theirs",
      "mine",
    ]);
    // Its own change coming back through the feed confirms it.
    feed({
      type: "changes",
      changes: [{ clientId: "me", seq: 1, ops: [write("s1.r1", "s1.c2", "mine")] }],
      revision: 2,
      moment,
    });
    expect(sync.getState()).toMatchObject({ pending: 0, revision: 2 });
  });

  it("takes a reset's word for which of its edits the server has", () => {
    const { sync, feed, answerWith } = connection();
    answerWith(() => {
      throw new Error("offline");
    });
    feed({ type: "reset", doc: emptyDoc(), revision: 0, moment, acked: null });
    sync.dispatch([write("s1.r1", "s1.c1", "one")]);
    sync.dispatch([write("s1.r2", "s1.c1", "two")]);
    feed({ type: "reset", doc: emptyDoc(), revision: 5, moment, acked: 1 });
    expect(sync.getState().pending).toBe(1);
    expect(valueAt(sync.getState().doc, "s1.r2", "s1.c1")).toBe("two");
  });

  it("sends what a closed tab left unsent, and forgets it once the server has it", async () => {
    const saved = new Map<string, SheetChange>();
    const outbox: SheetOutbox = {
      load: async () => [...saved.values()],
      add: (_documentId, change) => saved.set(`${change.clientId}:${change.seq}`, change),
      forget: async (_documentId, clientId, seq) => {
        for (const [key, change] of saved)
          if (change.clientId === clientId && change.seq <= seq) saved.delete(key);
      },
    };
    outbox.add("sheet-1", { clientId: "old", seq: 4, ops: [write("s1.r1", "s1.c1", "kept")] });
    const { sync, pushes, feed } = connection(outbox);
    feed({ type: "reset", doc: emptyDoc(), revision: 0, moment, acked: null });
    // Shown at once, as this tab's own unsent edits are.
    await Promise.resolve();
    expect(valueAt(sync.getState().doc, "s1.r1", "s1.c1")).toBe("kept");
    // The tab that made them, still open, adds another meanwhile: sending the first keeps it.
    outbox.add("sheet-1", { clientId: "old", seq: 5, ops: [write("s1.r4", "s1.c1", "later")] });
    await vi.runAllTimersAsync();
    expect(pushes[0]).toMatchObject({ clientId: "old" });
    expect([...saved.keys()]).toEqual(["old:5"]);
    feed({
      type: "changes",
      changes: [{ clientId: "old", seq: 4, ops: [write("s1.r1", "s1.c1", "kept")] }],
      revision: 1,
      moment,
    });
    expect(valueAt(sync.getState().doc, "s1.r1", "s1.c1")).toBe("kept");
    // This tab's own edits go under its own client, kept until sent.
    sync.dispatch([write("s1.r2", "s1.c1", "new")]);
    expect(saved.has("me:1")).toBe(true);
  });

  it("refuses a change the server would refuse whole, sending it nowhere", async () => {
    const { sync, pushes, feed } = connection();
    feed({ type: "reset", doc: emptyDoc(), revision: 0, moment, acked: null });
    sync.dispatch([
      {
        op: "format",
        sh: "s1",
        area: { r1: "s1.r1", r2: "s1.r1", c1: "s1.c1", c2: "s1.c1" },
        patch: { fontColor: "red" },
      } as never,
    ]);
    await vi.runAllTimersAsync();
    expect(pushes).toHaveLength(0);
    expect(sync.getState()).toMatchObject({ pending: 0, canUndo: false });
    expect(sync.getState().refused).toMatch(/^That change can’t be made: /);
    // The next good edit goes, under the same numbers.
    sync.dispatch([write("s1.r1", "s1.c1", "fine")]);
    await vi.runAllTimersAsync();
    expect(JSON.parse(pushes[0]!.changes![0]!)).toMatchObject({ seq: 1 });
  });
});
