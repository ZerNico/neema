import { describe, expect, it, vi } from "vitest";
import {
  flushBlockSaves,
  registerBlockFlush,
  trackBlockSave,
  trackBlockWork,
} from "./pending-saves.ts";

const later = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("pending block saves", () => {
  it("lets a running handler finish before flushing, so its state is the one saved", async () => {
    const order: string[] = [];
    const handler = later();
    trackBlockWork(handler.promise.then(() => order.push("handler done")));
    const unregister = registerBlockFlush(() => order.push("flush"));
    const flushing = flushBlockSaves();
    handler.resolve();
    await flushing;
    unregister();
    expect(order).toEqual(["handler done", "flush"]);
  });

  it("lets a send go at its deadline past a stuck save, which still orders the next", async () => {
    vi.useFakeTimers();
    try {
      const started: string[] = [];
      trackBlockSave("b-stuck", () => {
        started.push("stuck");
        return new Promise<void>(() => {});
      });
      trackBlockSave("b-stuck", async () => {
        started.push("next");
      });
      let sent = false;
      void flushBlockSaves().then(() => (sent = true));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(sent).toBe(true);
      // Released early, the stuck request could land after this one.
      expect(started).toEqual(["stuck"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends one block's saves in order, never two at once", async () => {
    const started: string[] = [];
    const first = later();
    trackBlockSave("b1", () => {
      started.push("old");
      return first.promise;
    });
    trackBlockSave("b1", async () => {
      started.push("new");
    });
    await Promise.resolve();
    // The newer save waits: landing first, the older one would overwrite it.
    expect(started).toEqual(["old"]);
    first.resolve();
    await flushBlockSaves();
    expect(started).toEqual(["old", "new"]);
  });
});
