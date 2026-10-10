import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyDoc, type SheetDoc } from "@chat/sheet/model";
import type { SheetChange, SheetOp } from "@chat/sheet/model/ops";
import type { PushSheetInput, PushSheetResult, SheetFrame } from "../schema.ts";
import { SheetSync, type SheetFeedSource } from "./sheet-sync.ts";

const moment = { now: 45_000, seed: 1 };
const write = (r: string, c: string, v: string): SheetOp => ({
  op: "set",
  sh: "s1",
  cells: [{ r, c, v }],
});
const valueAt = (doc: SheetDoc | null, r: string, c: string) => doc?.sheet.s1!.cells[r]?.[c]?.v;

/** A sheet connection with a feed the test drives and a push it answers. */
function connection() {
  const listeners = new Map<string, (event: MessageEvent<string>) => void>();
  const source: SheetFeedSource = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    close: () => {},
  };
  const pushes: PushSheetInput[] = [];
  let answer: (input: PushSheetInput) => PushSheetResult = (input) => ({
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
});
