import { afterEach, expect, it, vi } from "vitest";
import { browserCalls } from "./calls.ts";

const ledgers: ReturnType<typeof browserCalls>[] = [];
const fixture = (onExpire?: (id: string) => void) => {
  vi.useFakeTimers();
  const calls = browserCalls(onExpire);
  ledgers.push(calls);
  return calls;
};
afterEach(() => {
  for (const calls of ledgers.splice(0)) calls.clear();
  vi.useRealTimers();
});

it("refuses late start after cancellation and changes to an active identity", () => {
  const calls = fixture();
  calls.end("cancelled");
  expect(() => calls.begin("cancelled", "chat", Date.now() + 1000)).toThrow("ended");
  const deadline = Date.now() + 1000;
  calls.begin("live", "chat", deadline);
  calls.begin("live", "chat", deadline);
  expect(() => calls.begin("live", "other", deadline)).toThrow("changed");
  expect(() => calls.begin("live", "chat", deadline + 1)).toThrow("changed");
  const context = calls.get("live");
  calls.end("live");
  expect(context.signal.aborted).toBe(true);
  expect(() => context.check()).toThrow();
  expect(() => calls.begin("live", "chat", deadline)).toThrow("ended");
});

it("checks the deadline even before the timer can run", () => {
  const expired = vi.fn();
  const calls = fixture(expired);
  calls.begin("call", "chat", Date.now() + 10);
  const context = calls.get("call");
  vi.setSystemTime(Date.now() + 10);
  expect(() => context.check()).toThrow("expired");
  expect(context.signal.aborted).toBe(true);
  expect(expired).toHaveBeenCalledExactlyOnceWith("call");
});

it("does not lose an unrecorded cancellation as capacity starts pruning", () => {
  const calls = fixture();
  for (let n = 0; n < 512; n++) calls.end(`old-${n}`);
  vi.setSystemTime(Date.now() + 100);
  const deadline = Date.now() + 5 * 60_000;
  calls.end("unrecorded");
  vi.setSystemTime(Date.now() + 5 * 60_000 - 100);
  expect(() => calls.begin("unrecorded", "chat", deadline)).toThrow("Too many");
  vi.setSystemTime(deadline);
  expect(() => calls.begin("unrecorded", "chat", deadline)).toThrow("deadline");
  calls.begin("fresh", "chat", Date.now() + 1000);
});
