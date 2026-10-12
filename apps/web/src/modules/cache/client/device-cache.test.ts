import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearDeviceCaches, deviceCache, setDeviceCacheOwner } from "./device-cache.ts";

// Each test opens a fresh namespace, the way a later page load would: a new
// cache object reads only what the store holds.
let n = 0;
const reopen = <V>(namespace: string, maxBytes = 10_000) =>
  deviceCache<V>({ namespace, maxBytes, maxEntryBytes: 1_000 });
const fresh = () => `test-${++n}`;

/** Holds delivery after IndexedDB has captured a read, not its transaction or clock. */
function holdRead(method: "get" | "getAll", namespace: string) {
  const held = Promise.withResolvers<() => void>();
  const original = IDBObjectStore.prototype[method];
  const spy = vi.spyOn(IDBObjectStore.prototype, method).mockImplementation(function (
    this: IDBObjectStore,
    query: IDBValidKey | IDBKeyRange,
  ) {
    const req = original.call(this, query);
    const lower = query instanceof IDBKeyRange ? query.lower : query;
    if (!Array.isArray(lower) || lower[1] !== namespace) return req;
    spy.mockRestore();
    const add = req.addEventListener.bind(req);
    vi.spyOn(req, "addEventListener").mockImplementation((type, listener, options) => {
      if (type !== "success") return add(type, listener, options);
      add(
        type,
        (event) =>
          held.resolve(() => {
            if (typeof listener === "function") listener.call(req, event);
            else listener?.handleEvent(event);
          }),
        options,
      );
    });
    return req;
  });
  return held.promise;
}

afterEach(() => vi.restoreAllMocks());

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
    const clock = vi.spyOn(Date, "now").mockReturnValue(1);
    cache.set("old", "x".repeat(150));
    clock.mockReturnValue(2);
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

  it("keeps everything in a namespace that is not a cache, over budget or not", async () => {
    setDeviceCacheOwner("alice");
    const name = fresh();
    const cache = deviceCache<string>({
      namespace: name,
      maxBytes: 300,
      maxEntryBytes: 200,
      keep: true,
    });
    await cache.warm();
    cache.set("old", "x".repeat(150));
    cache.set("new", "y".repeat(150));
    cache.set("huge", "z".repeat(500));
    expect([cache.get("old")?.length, cache.get("new")?.length, cache.get("huge")?.length]).toEqual(
      [150, 150, 500],
    );
  });

  it("does not bring back an entry deleted while the namespace was loading", async () => {
    setDeviceCacheOwner("alice");
    const name = fresh();
    const first = reopen<string>(name);
    await first.warm();
    first.set("k", "old");
    await first.flush();

    const next = reopen<string>(name);
    const captured = holdRead("getAll", name);
    const warming = next.warm();
    const release = await captured;
    next.delete("k");
    await next.flush();
    release();
    await warming;
    expect(next.get("k")).toBeUndefined();
  });

  it("enumerates pending additions and tombstones without hiding another tab’s writes", async () => {
    setDeviceCacheOwner("alice");
    const name = fresh();
    const cache = reopen<string>(name);
    await cache.warm();
    cache.set("p/deleted", "gone");
    cache.set("p/shared", "old");
    await cache.flush();
    const other = reopen<string>(name);
    await other.warm();
    other.set("p/shared", "other tab");
    other.set("p/remote", "remote");
    await other.flush();
    cache.delete("p/deleted");
    cache.set("p/local", "pending");
    expect(new Map(await cache.reloadAll("p/"))).toEqual(
      new Map([
        ["p/shared", "other tab"],
        ["p/remote", "remote"],
        ["p/local", "pending"],
      ]),
    );
    await cache.flush();
  });

  it.each(["set", "delete"] as const)(
    "keeps a newer %s after a stale single read and its flush complete",
    async (op) => {
      setDeviceCacheOwner("alice");
      const name = fresh();
      const cache = reopen<string>(name);
      await cache.warm();
      cache.set("k", "old");
      await cache.flush();
      const captured = holdRead("get", name);
      const reading = cache.reload("k");
      const release = await captured;
      if (op === "set") cache.set("k", "new");
      else cache.delete("k");
      await cache.flush();
      release();
      expect(await reading).toBe(op === "set" ? "new" : undefined);
      expect(cache.get("k")).toBe(op === "set" ? "new" : undefined);
      const next = reopen<string>(name);
      await next.warm();
      expect(next.get("k")).toBe(cache.get("k"));
    },
  );

  it("keeps a prefix read coherent after its pending batch and newer touches both flush", async () => {
    setDeviceCacheOwner("alice");
    const name = fresh();
    const cache = reopen<string>(name);
    await cache.warm();
    cache.set("p/changed", "old");
    cache.set("p/deleted", "old");
    await cache.flush();
    cache.set("p/pending", "pending at read");
    const captured = holdRead("getAll", name);
    const reading = cache.reloadAll("p/");
    const release = await captured;
    await cache.flush();
    cache.set("p/changed", "new");
    cache.delete("p/deleted");
    cache.set("p/added", "after read");
    await cache.flush();
    release();
    expect(new Map(await reading)).toEqual(
      new Map([
        ["p/changed", "new"],
        ["p/pending", "pending at read"],
        ["p/added", "after read"],
      ]),
    );
    expect(new Map(await reopen<string>(name).reloadAll("p/"))).toEqual(
      new Map(await cache.reloadAll("p/")),
    );
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
