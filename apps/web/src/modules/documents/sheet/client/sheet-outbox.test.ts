import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SheetChange } from "@chat/sheet/model/ops";
import { deviceCache, setDeviceCacheOwner } from "~/modules/cache/client/device-cache.ts";
import { sheetOutboxFor, type UnsentSheetChange } from "./sheet-outbox.ts";

let namespace = 0;
const open = (name: string) => {
  const store = deviceCache<UnsentSheetChange>({ namespace: name, keep: true, maxBytes: 1_000 });
  return { store, outbox: sheetOutboxFor(store) };
};
const change = (clientId: string, seq: number): SheetChange => ({
  clientId,
  seq,
  ops: [{ op: "set", sh: "s1", cells: [{ r: "s1.r1", c: "s1.c1", v: `${clientId}:${seq}` }] }],
});
const keyOf = (documentId: string, clientId: string, seq: number) =>
  `${documentId}\u0000${clientId}\u0000${seq}`;

/** The request captures real persisted rows before its promise is allowed to finish. */
function holdEnumeration() {
  const held = Promise.withResolvers<() => void>();
  const original = IDBObjectStore.prototype.getAll;
  const spy = vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (
    this: IDBObjectStore,
    query,
  ) {
    const req = original.call(this, query);
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

/** Keeps a captured batch in flight after the actual IDB commit, without a clock delay. */
function holdFlushCompletion() {
  const held = Promise.withResolvers<() => void>();
  const add = IDBTransaction.prototype.addEventListener;
  const spy = vi.spyOn(IDBTransaction.prototype, "addEventListener").mockImplementation(function (
    this: IDBTransaction,
    type,
    listener,
    options,
  ) {
    if (type !== "complete" || this.mode !== "readwrite")
      return add.call(this, type, listener, options);
    spy.mockRestore();
    add.call(
      this,
      type,
      (event) =>
        held.resolve(() => {
          if (typeof listener === "function") listener.call(this, event);
          else listener?.handleEvent(event);
        }),
      options,
    );
  });
  return held.promise;
}

afterEach(() => vi.restoreAllMocks());

describe("the persisted sheet outbox", () => {
  it("forgets acknowledged pending changes before flush and preserves other clients, documents and newer sequences", async () => {
    setDeviceCacheOwner("sheet-outbox-owner");
    const name = `outbox-${++namespace}`;
    const { store, outbox } = open(name);
    await store.warm();
    outbox.add("doc", change("a", 1));
    outbox.add("doc", change("a", 2));
    outbox.add("doc", change("b", 1));
    outbox.add("other-doc", change("a", 1));
    const forgetting = outbox.forget("doc", "a", 1);
    expect(store.get(keyOf("doc", "a", 1))).toBeUndefined();
    await forgetting;
    await store.flush();
    const reopened = open(name).outbox;
    expect(await reopened.load("doc")).toEqual([change("a", 2), change("b", 1)]);
    expect(await reopened.load("other-doc")).toEqual([change("a", 1)]);
  });

  it("forgets during a captured flush and never restores that batch after its completion", async () => {
    setDeviceCacheOwner("sheet-outbox-owner");
    const name = `outbox-${++namespace}`;
    const { store, outbox } = open(name);
    await store.warm();
    outbox.add("doc", change("a", 1));
    const completion = holdFlushCompletion();
    const flushing = store.flush();
    const release = await completion;
    expect(await outbox.load("doc")).toEqual([change("a", 1)]);
    const forgetting = outbox.forget("doc", "a", 1);
    expect(store.get(keyOf("doc", "a", 1))).toBeUndefined();
    outbox.add("doc", change("a", 2));
    outbox.add("doc", change("b", 1));
    await forgetting;
    await store.flush();
    expect(await outbox.load("doc")).toEqual([change("a", 2), change("b", 1)]);
    release();
    await flushing;
    expect(await open(name).outbox.load("doc")).toEqual([change("a", 2), change("b", 1)]);
  });

  it("overlays a stale recovery read after acknowledgement and a newer flush", async () => {
    setDeviceCacheOwner("sheet-outbox-owner");
    const name = `outbox-${++namespace}`;
    const { store, outbox } = open(name);
    await store.warm();
    outbox.add("doc", change("a", 1));
    outbox.add("doc", change("b", 1));
    await store.flush();
    const captured = holdEnumeration();
    const recovery = outbox.load("doc");
    const release = await captured;
    await outbox.forget("doc", "a", 1);
    outbox.add("doc", change("a", 2));
    await store.flush();
    release();
    expect(await recovery).toEqual([change("a", 2), change("b", 1)]);
    expect(await open(name).outbox.load("doc")).toEqual([change("a", 2), change("b", 1)]);
  });

  it("finds and retires acknowledged entries persisted by another tab after warming", async () => {
    setDeviceCacheOwner("sheet-outbox-owner");
    const name = `outbox-${++namespace}`;
    const tab = open(name);
    await tab.store.warm();
    const other = open(name);
    await other.store.warm();
    other.outbox.add("doc", change("old-client", 1));
    other.outbox.add("doc", change("old-client", 2));
    other.outbox.add("doc", change("other-client", 1));
    other.outbox.add("other-doc", change("old-client", 1));
    await other.store.flush();
    await tab.outbox.forget("doc", "old-client", 1);
    await tab.store.flush();
    const reopened = open(name).outbox;
    expect(await reopened.load("doc")).toEqual([
      change("old-client", 2),
      change("other-client", 1),
    ]);
    expect(await reopened.load("other-doc")).toEqual([change("old-client", 1)]);
  });
});
