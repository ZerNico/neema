import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { clearDeviceCaches, deviceCache, setDeviceCacheOwner } from "./device-cache.ts";

// Each test opens a fresh namespace, the way a later page load would: a new
// cache object reads only what the store holds.
let n = 0;
const reopen = <V>(namespace: string, maxBytes = 10_000) =>
  deviceCache<V>({ namespace, maxBytes, maxEntryBytes: 1_000 });
const fresh = () => `test-${++n}`;

describe("deviceCache", () => {
  it("keeps values for the next visit and reads them synchronously once warm", async () => {
    setDeviceCacheOwner("alice");
    const name = fresh();
    const first = reopen<{ n: number }>(name);
    await first.warm();
    first.set("a", { n: 1 });
    expect(first.get("a")).toEqual({ n: 1 });
    await first.flush();

    const next = reopen<{ n: number }>(name);
    expect(next.get("a")).toBeUndefined();
    await next.warm();
    expect(next.get("a")).toEqual({ n: 1 });
  });

  it("drops the oldest entries over the budget and refuses one too large", async () => {
    setDeviceCacheOwner("alice");
    const name = fresh();
    const cache = deviceCache<string>({ namespace: name, maxBytes: 300, maxEntryBytes: 200 });
    await cache.warm();
    cache.set("old", "x".repeat(150));
    await new Promise((resolve) => setTimeout(resolve, 2));
    cache.set("new", "y".repeat(150));
    cache.set("huge", "z".repeat(500));
    expect(cache.get("old")).toBeUndefined();
    expect(cache.get("new")).toBeDefined();
    expect(cache.get("huge")).toBeUndefined();
    await cache.flush();
    const next = reopen<string>(name);
    await next.warm();
    expect([next.get("old"), next.get("new")?.length, next.get("huge")]).toEqual([
      undefined,
      150,
      undefined,
    ]);
  });

  it("keeps namespaces apart", async () => {
    setDeviceCacheOwner("alice");
    const [one, two] = [fresh(), fresh()];
    const a = reopen<number>(one);
    await a.warm();
    a.set("k", 1);
    await a.flush();
    const b = reopen<number>(two);
    await b.warm();
    expect(b.get("k")).toBeUndefined();
  });

  it("never shows one identity's entries to the next, and clears on leaving", async () => {
    setDeviceCacheOwner("alice");
    const name = fresh();
    const mine = reopen<string>(name);
    await mine.warm();
    mine.set("secret", "alice's tree");
    await mine.flush();
    expect(mine.get("secret")).toBe("alice's tree");

    // Bob signs in on the same browser: memory is dropped and the store purged.
    setDeviceCacheOwner("bob");
    expect(mine.get("secret")).toBeUndefined();
    const bobs = reopen<string>(name);
    await bobs.warm();
    expect(bobs.get("secret")).toBeUndefined();
    setDeviceCacheOwner("alice");
    const back = reopen<string>(name);
    await back.warm();
    expect(back.get("secret")).toBeUndefined();

    back.set("again", "x");
    await back.flush();
    await clearDeviceCaches();
    setDeviceCacheOwner("alice");
    const after = reopen<string>(name);
    await after.warm();
    expect(after.get("again")).toBeUndefined();
  });
});
