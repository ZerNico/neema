// Caches kept on this device in IndexedDB, for things worth showing at once
// on the next visit and cheap to lose. One database and one store hold every
// cache, keyed [owner, namespace, key], so a new cache is a new namespace with
// no schema change. Reads are synchronous from memory once a namespace is warm;
// writes are batched behind them. Any storage failure leaves a memory-only
// cache, never an error: everything here can be rebuilt.
//
// Entries belong to the signed-in identity. Opening for one deletes every
// other identity's entries first, so a session that ended outside the app
// leaves nothing readable for whoever signs in next.

const DB_NAME = "neema-cache";
const STORE = "entries";

type Key = [owner: string, namespace: string, key: string];

interface Stored<V> {
  readonly value: V;
  readonly at: number;
  readonly bytes: number;
}

export interface DeviceCacheOptions {
  /** Unique per cache; it is part of every key. */
  readonly namespace: string;
  /** The namespace's budget, roughly in UTF-16 units of its JSON. The oldest go first. */
  readonly maxBytes: number;
  /** A value over this is not kept at all. Defaults to `maxBytes / 8`. */
  readonly maxEntryBytes?: number;
  /**
   * Data that is not a cache: nothing is evicted for the budget or refused
   * for its size. Another tab may own an entry this one loaded, and losing
   * it would lose work rather than a placeholder.
   */
  readonly keep?: boolean;
}

export interface DeviceCache<V> {
  /** Loads the namespace into memory; resolves at once if it is already, or storage is unusable. */
  warm(): Promise<void>;
  /** The value, if warm and present. */
  get(key: string): V | undefined;
  /**
   * The value as storage holds it now, for one another tab may have written
   * since this one warmed. A local change not yet written stays ahead of it.
   */
  reload(key: string): Promise<V | undefined>;
  /** Every stored entry whose key starts with `prefix`, as storage holds them now. */
  reloadAll(prefix: string): Promise<Array<[string, V]>>;
  set(key: string, value: V): void;
  delete(key: string): void;
}

// ---- the connection and the owner

let owner: string | null = null;
let ownerSet: (() => void) | null = null;
let ownerKnown = new Promise<void>((resolve) => {
  ownerSet = resolve;
});
let database: Promise<IDBDatabase | null> | null = null;
const caches = new Set<NamespaceCache<unknown>>();

const request = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.addEventListener("success", () => resolve(req.result));
    req.addEventListener("error", () => reject(req.error));
  });

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.addEventListener("complete", () => resolve());
    tx.addEventListener("error", () => reject(tx.error));
    tx.addEventListener("abort", () => reject(tx.error));
  });

function open(): Promise<IDBDatabase | null> {
  database ??= (async () => {
    if (typeof indexedDB === "undefined") return null;
    const req = indexedDB.open(DB_NAME, 1);
    req.addEventListener("upgradeneeded", () => req.result.createObjectStore(STORE));
    const db = await request(req);
    // Another tab upgrading later must not be blocked by this connection.
    db.addEventListener("versionchange", () => db.close());
    return db;
  })().catch(() => null);
  return database;
}

/** Deletes every entry not under `keep`: lower keys, then higher ones. */
async function purgeOthers(db: IDBDatabase, keep: string) {
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  // [keep] sorts before every [keep, …]; [keep, []] after them, arrays above strings.
  store.delete(IDBKeyRange.upperBound([keep]));
  store.delete(IDBKeyRange.lowerBound([keep, []], true));
  await done(tx);
}

/**
 * The identity whose caches are open. Called once the session is known; a
 * different identity drops what memory holds and purges the old one's entries.
 */
export function setDeviceCacheOwner(next: string): void {
  if (owner === next) return;
  const changed = owner !== null;
  owner = next;
  if (changed) for (const cache of caches) cache.reset();
  ownerSet?.();
  ownerSet = null;
  void open().then((db) => (db ? purgeOthers(db, next).catch(() => {}) : undefined));
}

/** Forgets every cache on this device, for the identity leaving it. */
export async function clearDeviceCaches(): Promise<void> {
  for (const cache of caches) cache.reset();
  owner = null;
  ownerKnown = new Promise<void>((resolve) => {
    ownerSet = resolve;
  });
  const db = await open();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    // Sent now rather than at the next turn, as the page may be leaving.
    tx.commit();
    await done(tx);
  } catch {
    /* Already unusable: nothing readable remains. */
  }
}

// ---- one namespace

const WRITE_DELAY_MS = 300;
const sizeOf = (value: unknown) => JSON.stringify(value)?.length ?? 0;

class NamespaceCache<V> implements DeviceCache<V> {
  private memory = new Map<string, Stored<V>>();
  private bytes = 0;
  private loading: Promise<void> | null = null;
  /**
   * Keys set or deleted while a load is reading. The read is older than them,
   * so it must not bring a deleted entry back or replace a newer one; the
   * pending writes cannot say so once a flush has taken them.
   */
  private touched: Set<string> | null = null;
  /** Keys to write (with their entry) or delete (undefined) on the next flush. */
  private dirty = new Map<string, Stored<V> | undefined>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxEntryBytes: number;

  constructor(private readonly options: DeviceCacheOptions) {
    this.maxEntryBytes = options.maxEntryBytes ?? options.maxBytes / 8;
  }

  warm(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }

  private async load() {
    this.touched = new Set();
    try {
      await this.read();
    } finally {
      this.touched = null;
    }
  }

  private async read() {
    await ownerKnown;
    const forOwner = owner;
    const db = await open();
    if (!db || forOwner === null) return;
    try {
      const tx = db.transaction(STORE, "readonly");
      const range = IDBKeyRange.bound(
        [forOwner, this.options.namespace],
        [forOwner, this.options.namespace, []],
        false,
        true,
      );
      const [keys, values] = await Promise.all([
        request(tx.objectStore(STORE).getAllKeys(range)),
        request(tx.objectStore(STORE).getAll(range)),
      ]);
      if (owner !== forOwner) return;
      keys.forEach((raw, i) => {
        const key = (raw as Key)[2];
        // A value set or deleted while loading is newer than the stored one.
        if (this.touched?.has(key) || this.memory.has(key) || this.dirty.has(key)) return;
        const entry = values[i] as Stored<V>;
        this.memory.set(key, entry);
        this.bytes += entry.bytes;
      });
      this.evict();
    } catch {
      /* Memory only from here. */
    }
  }

  get(key: string): V | undefined {
    return this.memory.get(key)?.value;
  }

  async reloadAll(prefix: string): Promise<Array<[string, V]>> {
    await ownerKnown;
    const forOwner = owner;
    const db = await open();
    const local = () =>
      [...this.memory]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, entry]) => [key, entry.value] as [string, V]);
    if (!db || forOwner === null) return local();
    try {
      const tx = db.transaction(STORE, "readonly");
      const range = IDBKeyRange.bound(
        [forOwner, this.options.namespace, prefix],
        [forOwner, this.options.namespace, `${prefix}\uffff`],
      );
      const [keys, values] = await Promise.all([
        request(tx.objectStore(STORE).getAllKeys(range)),
        request(tx.objectStore(STORE).getAll(range)),
      ]);
      if (owner !== forOwner) return local();
      return keys.map((raw, index) => [(raw as Key)[2], (values[index] as Stored<V>).value]);
    } catch {
      return local();
    }
  }

  async reload(key: string): Promise<V | undefined> {
    await ownerKnown;
    const forOwner = owner;
    const db = await open();
    if (!db || forOwner === null || this.dirty.has(key)) return this.get(key);
    try {
      const tx = db.transaction(STORE, "readonly");
      const id: Key = [forOwner, this.options.namespace, key];
      const entry = (await request(tx.objectStore(STORE).get(id))) as Stored<V> | undefined;
      if (owner !== forOwner || this.dirty.has(key)) return this.get(key);
      this.drop(key);
      if (entry) {
        this.memory.set(key, entry);
        this.bytes += entry.bytes;
      }
      return entry?.value;
    } catch {
      return this.get(key);
    }
  }

  set(key: string, value: V): void {
    const bytes = sizeOf(value);
    this.drop(key);
    if (bytes > this.maxEntryBytes && !this.options.keep) {
      this.mark(key, undefined);
      return;
    }
    const entry = { value, at: Date.now(), bytes };
    this.memory.set(key, entry);
    this.bytes += bytes;
    this.mark(key, entry);
    this.evict();
  }

  delete(key: string): void {
    this.drop(key);
    this.mark(key, undefined);
  }

  /** Forgets memory and pending writes, as for another identity. */
  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.memory.clear();
    this.dirty.clear();
    this.bytes = 0;
    this.loading = null;
  }

  private drop(key: string) {
    const old = this.memory.get(key);
    if (!old) return;
    this.bytes -= old.bytes;
    this.memory.delete(key);
  }

  private evict() {
    if (this.options.keep || this.bytes <= this.options.maxBytes) return;
    const oldest = [...this.memory.entries()].toSorted((a, b) => a[1].at - b[1].at);
    for (const [key] of oldest) {
      if (this.bytes <= this.options.maxBytes) break;
      this.drop(key);
      this.mark(key, undefined);
    }
  }

  private mark(key: string, entry: Stored<V> | undefined) {
    this.touched?.add(key);
    this.dirty.set(key, entry);
    this.timer ??= setTimeout(() => void this.flush(), WRITE_DELAY_MS);
  }

  /** Writes what changed in one transaction. Exposed for pagehide and tests. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const forOwner = owner;
    if (this.dirty.size === 0 || forOwner === null) return;
    const batch = [...this.dirty];
    this.dirty.clear();
    const db = await open();
    if (!db || owner !== forOwner) return;
    try {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const [key, entry] of batch) {
        const id: Key = [forOwner, this.options.namespace, key];
        if (entry) store.put(entry, id);
        else store.delete(id);
      }
      await done(tx);
    } catch {
      /* A lost write costs a placeholder on the next visit, nothing more. */
    }
  }
}

/** A cache in its own namespace. Create it once, at module scope. */
export function deviceCache<V>(options: DeviceCacheOptions): DeviceCache<V> & {
  flush(): Promise<void>;
} {
  const cache = new NamespaceCache<V>(options);
  caches.add(cache as NamespaceCache<unknown>);
  return cache;
}

// Writes still waiting when the page goes away would be lost with it.
if (typeof addEventListener === "function") {
  addEventListener("pagehide", () => {
    for (const cache of caches) void cache.flush();
  });
}
