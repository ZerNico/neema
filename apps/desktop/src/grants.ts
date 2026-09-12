import { mkdir, readFile, writeFile } from "node:fs/promises";
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
 * Losing this file is a supported outcome: every conversation simply asks
 * again.
 */
export interface Grants {
  /** Absolute paths, in the order they were attached. Empty when never told one. */
  lookup(conversationId: string): Effect.Effect<ReadonlyArray<string>>;
  /** Appends; a path already present is left where it is. */
  remember(conversationId: string, folder: string): Effect.Effect<void>;
  /** Removes one path. */
  forget(conversationId: string, folder: string): Effect.Effect<void>;
  /** Removes every path under a key. */
  forgetAll(conversationId: string): Effect.Effect<void>;
}

/**
 * Reads the current `{ id: [path] }` shape and the two earlier single-folder
 * ones, `{ id: path }` and `{ id: { folder } }`.
 */
const parseFolders = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (!value || typeof value !== "object") return [];
  const folder = (value as { folder?: unknown }).folder;
  return typeof folder === "string" ? [folder] : [];
};

const withFolder = (folders: ReadonlyArray<string>, folder: string) =>
  folders.includes(folder) ? folders : [...folders, folder];

/** The store's behaviour, shared by the persisted and the in-memory layers. */
const makeStore = (
  state: Map<string, ReadonlyArray<string>>,
  persist: Effect.Effect<void>,
): Grants => ({
  lookup: (conversationId) => Effect.sync(() => state.get(conversationId) ?? []),
  remember: (conversationId, folder) =>
    Effect.suspend(() => {
      state.set(conversationId, withFolder(state.get(conversationId) ?? [], folder));
      return persist;
    }),
  forget: (conversationId, folder) =>
    Effect.suspend(() => {
      const rest = (state.get(conversationId) ?? []).filter((item) => item !== folder);
      if (rest.length === 0) state.delete(conversationId);
      else state.set(conversationId, rest);
      return persist;
    }),
  forgetAll: (conversationId) =>
    Effect.suspend(() => {
      state.delete(conversationId);
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
              const folders = parseFolders(value);
              if (folders.length > 0) entries.push([id, folders]);
            }
            return entries;
          } catch {
            return [];
          }
        });

        const state = new Map<string, ReadonlyArray<string>>(yield* read);
        const persist = Effect.promise(async () => {
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, JSON.stringify(Object.fromEntries(state), null, 2), "utf8");
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
