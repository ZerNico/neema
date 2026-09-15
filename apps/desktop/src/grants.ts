import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Context, Effect, Layer } from "effect";

/**
 * Which folders belong to which conversation, on this machine.
 *
 * Deliberately not on the server. The same conversation opened on a second
 * machine has no entry here and asks for a folder, which is the correct answer
 * rather than a special case; a server-held absolute path would be a claim
 * about a filesystem the server cannot see. It also means the grant lives where
 * the authority to honour it lives.
 *
 * Keys carry the server origin as well as the conversation id. Ids are minted
 * by whichever server the shell is connected to, so two servers can hand out
 * the same one, and a grant given to a conversation on one must not open the
 * folder to a conversation on the other.
 *
 * Losing this file is a supported outcome: every conversation simply asks
 * again. Entries written before the origin was part of the key are dropped
 * on read for the same reason.
 */
export interface Grants {
  /** Absolute paths, in the order they were attached. Empty when never told one. */
  lookup(key: GrantKey): Effect.Effect<ReadonlyArray<string>>;
  /** Appends; a path already present is left where it is. */
  remember(key: GrantKey, folder: string): Effect.Effect<void>;
  /** Removes one path. */
  forget(key: GrantKey, folder: string): Effect.Effect<void>;
  /** Removes every path under a key. */
  forgetAll(key: GrantKey): Effect.Effect<void>;
}

export interface GrantKey {
  readonly origin: string;
  readonly conversationId: string;
}

/** An origin never contains a space; the id after it may contain anything. */
const encodeKey = ({ origin, conversationId }: GrantKey) => `${origin} ${conversationId}`;
/** Matches what `encodeKey` writes; older files used the bare id. */
const ENCODED_KEY = /^https?:\/\/\S+ ./;

const withFolder = (folders: ReadonlyArray<string>, folder: string) =>
  folders.includes(folder) ? folders : [...folders, folder];

/** The store's behaviour, shared by the persisted and the in-memory layers. */
const makeStore = (
  state: Map<string, ReadonlyArray<string>>,
  persist: Effect.Effect<void>,
): Grants => ({
  lookup: (key) => Effect.sync(() => state.get(encodeKey(key)) ?? []),
  remember: (key, folder) =>
    Effect.suspend(() => {
      const id = encodeKey(key);
      state.set(id, withFolder(state.get(id) ?? [], folder));
      return persist;
    }),
  forget: (key, folder) =>
    Effect.suspend(() => {
      const id = encodeKey(key);
      const rest = (state.get(id) ?? []).filter((item) => item !== folder);
      if (rest.length === 0) state.delete(id);
      else state.set(id, rest);
      return persist;
    }),
  forgetAll: (key) =>
    Effect.suspend(() => {
      state.delete(encodeKey(key));
      return persist;
    }),
});

export class GrantStore extends Context.Service<GrantStore, Grants>()("desktop/GrantStore") {
  static readonly layerAt = (file: string) =>
    Layer.effect(
      GrantStore,
      Effect.gen(function* () {
        const read = Effect.promise(async (): Promise<Array<[string, string[]]>> => {
          try {
            const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
            if (!parsed || typeof parsed !== "object") return [];
            // Only paths survive: a hand-edited or corrupted file must not put
            // a non-path into the containment check.
            const entries: Array<[string, string[]]> = [];
            for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
              if (!ENCODED_KEY.test(id) || !Array.isArray(value)) continue;
              const folders = value.filter((item): item is string => typeof item === "string");
              if (folders.length > 0) entries.push([id, folders]);
            }
            return entries;
          } catch {
            return [];
          }
        });

        const state = new Map<string, ReadonlyArray<string>>(yield* read);
        // Mutations are sync; writes are not. Overlapping writeFile calls of a
        // whole-map snapshot can finish out of order and resurrect a detached
        // folder after restart. One chain, stringify at write time, rename.
        let writes = Promise.resolve();
        const persist = Effect.promise(() => {
          const write = async () => {
            await mkdir(dirname(file), { recursive: true });
            const tmp = `${file}.${process.pid}.tmp`;
            await writeFile(tmp, JSON.stringify(Object.fromEntries(state), null, 2), "utf8");
            await rename(tmp, file);
          };
          const next = writes.then(write, write);
          writes = next.then(
            () => undefined,
            () => undefined,
          );
          return next;
        });
        return GrantStore.of(makeStore(state, persist));
      }),
    );

  /** In-memory, for tests and for a shell running without a writable profile. */
  static readonly layerEphemeral = Layer.effect(
    GrantStore,
    Effect.sync(() => GrantStore.of(makeStore(new Map(), Effect.void))),
  );
}

export const grantsFile = (userData: string) => join(userData, "folders.json");
