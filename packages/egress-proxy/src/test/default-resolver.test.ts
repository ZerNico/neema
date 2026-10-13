import { expect, test, vi } from "vitest";
import { createDefaultResolver, LookupGate, type Lookup } from "../resolver.ts";
import { allow, Clock, deferred, fixture } from "./helpers.ts";

type Answers = Awaited<ReturnType<Lookup>>;

/** A lookup that answers only when the test says so, one pending result per call. */
type Call = { host: string; answer: ReturnType<typeof deferred<Answers>> };

const pendingLookup = () => {
  const calls: Call[] = [];
  const started: Array<ReturnType<typeof deferred<Call>>> = [];
  const nth = (index: number) => (started[index] ??= deferred<Call>());
  const lookup = vi.fn<Lookup>((host) => {
    const call = { host, answer: deferred<Answers>() };
    nth(calls.length).resolve(call);
    calls.push(call);
    return call.answer.promise;
  });
  /** Resolves when the system lookup with this index starts. */
  const call = (index: number) => nth(index).promise;
  return { lookup, calls, call };
};

const settledOutcome = async (promise: Promise<unknown>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

test("names are looked up fully qualified, so search domains never apply", async () => {
  const { lookup, call } = pendingLookup();
  const resolve = createDefaultResolver(30_000, new Clock().timers, lookup, new LookupGate());
  const result = resolve("git", new AbortController().signal);
  (await call(0)).answer.resolve([{ address: "10.0.0.5", family: 4 }]);
  expect(await result).toEqual([{ address: "10.0.0.5", family: 4 }]);
  expect(lookup).toHaveBeenCalledExactlyOnceWith("git.");
});

test("answers keep their order and drop families other than 4 and 6", async () => {
  const { lookup, call } = pendingLookup();
  const resolve = createDefaultResolver(30_000, new Clock().timers, lookup, new LookupGate());
  const result = resolve("example.com", new AbortController().signal);
  (await call(0)).answer.resolve([
    { address: "2001:db8::1", family: 6 },
    { address: "93.184.216.34", family: 4 },
    { address: "weird", family: 0 },
  ]);
  expect(await result).toEqual([
    { address: "2001:db8::1", family: 6 },
    { address: "93.184.216.34", family: 4 },
  ]);
});

test("a lookup error rejects without echoing the system's message", async () => {
  const { lookup, call } = pendingLookup();
  const resolve = createDefaultResolver(30_000, new Clock().timers, lookup, new LookupGate());
  const result = settledOutcome(resolve("example.com", new AbortController().signal));
  (await call(0)).answer.reject(new Error("getaddrinfo ENOTFOUND secret-token"));
  const outcome = await result;
  expect(outcome.ok).toBe(false);
  expect(String(outcome.ok ? "" : outcome.error)).not.toContain("secret-token");
});

test("at most two lookups run at once; the third waits for a slot", async () => {
  const { lookup, call } = pendingLookup();
  const resolve = createDefaultResolver(30_000, new Clock().timers, lookup, new LookupGate());
  const results = ["a.example", "b.example", "c.example"].map((host) =>
    resolve(host, new AbortController().signal),
  );
  expect([(await call(0)).host, (await call(1)).host]).toEqual(["a.example.", "b.example."]);
  (await call(0)).answer.resolve([]);
  await results[0];
  expect((await call(2)).host).toBe("c.example.");
});

test("an abandoned running lookup keeps its slot until the system answers", async () => {
  const { lookup, calls, call } = pendingLookup();
  const gate = new LookupGate();
  const resolve = createDefaultResolver(30_000, new Clock().timers, lookup, gate);
  const abandoned = [new AbortController(), new AbortController()];
  const firstTwo = abandoned.map((controller, index) =>
    settledOutcome(resolve(`${index}.example`, controller.signal)),
  );
  // Both system lookups are running before their connections give up.
  await call(0);
  await call(1);
  for (const controller of abandoned) controller.abort();
  expect((await Promise.all(firstTwo)).every(({ ok }) => !ok)).toBe(true);

  // Retrying cannot start more system lookups while the abandoned two still run.
  const retry = resolve("retry.example", new AbortController().signal);
  expect(calls).toHaveLength(2);
  (await call(0)).answer.resolve([]);
  (await call(2)).answer.resolve([{ address: "93.184.216.34", family: 4 }]);
  expect(await retry).toEqual([{ address: "93.184.216.34", family: 4 }]);
});

test("a waiter that gives up leaves the queue and never runs", async () => {
  const { lookup, call } = pendingLookup();
  const resolve = createDefaultResolver(30_000, new Clock().timers, lookup, new LookupGate());
  resolve("a.example", new AbortController().signal).catch(() => {});
  resolve("b.example", new AbortController().signal).catch(() => {});
  const waiter = new AbortController();
  const waiting = settledOutcome(resolve("c.example", waiter.signal));
  waiter.abort();
  expect((await waiting).ok).toBe(false);
  (await call(0)).answer.resolve([]);
  (await call(1)).answer.resolve([]);
  const next = resolve("d.example", new AbortController().signal);
  expect((await call(2)).host).toBe("d.example.");
  (await call(2)).answer.resolve([]);
  await next;
});

test("the deadline rejects a lookup that never answers", async () => {
  const clock = new Clock();
  const { lookup } = pendingLookup();
  const resolve = createDefaultResolver(37, clock.timers, lookup, new LookupGate());
  const result = settledOutcome(resolve("slow.example", new AbortController().signal));
  await clock.scheduled(37);
  clock.advance(37);
  expect((await result).ok).toBe(false);
});

test("an already abandoned lookup never reaches the system", async () => {
  const { lookup } = pendingLookup();
  const resolve = createDefaultResolver(30_000, new Clock().timers, lookup, new LookupGate());
  const controller = new AbortController();
  controller.abort();
  expect((await settledOutcome(resolve("example.com", controller.signal))).ok).toBe(false);
  expect(lookup).not.toHaveBeenCalled();
});

// Whatever ends a connection while its name resolves must tell the resolver, or
// the lookup's slot and work outlive the connection that wanted it.
for (const stop of ["EOF", "deadline", "revoke", "regrant", "shutdown"] as const) {
  test(`${stop} during resolution aborts the lookup`, async () => {
    const entered = deferred<AbortSignal>();
    const aborted = deferred<void>();
    let allowed = true;
    const f = await fixture({
      resolve: (_host, signal) => {
        signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        entered.resolve(signal);
        return new Promise(() => {});
      },
      decide: () => (allowed ? allow() : { allowed: false }),
      limits: { establishMs: 37 },
    });
    const client = await f.open();
    const signal = await entered.promise;
    expect(signal.aborted).toBe(false);
    if (stop === "EOF") client.socket.end();
    if (stop === "deadline") {
      await f.clock.scheduled(37);
      f.clock.advance(37);
    }
    if (stop === "revoke") f.proxy.revoke(f.token);
    if (stop === "regrant") {
      allowed = false;
      f.proxy.regrant("grant-a");
    }
    if (stop === "shutdown") await f.close();
    await aborted.promise;
    expect(f.connect).not.toHaveBeenCalled();
  });
}
