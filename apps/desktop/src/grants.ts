import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import type { Mount } from "./computer/paths.ts";
import { folderName } from "./folders.ts";
import { serialWrites, writeJsonAtomic } from "./json-file.ts";

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
 * on read for the same reason. Each folder is mounted into the chat's computer
 * at `/folders/<name>`, read-only when the person chose so.
 */
/** One attached folder: its real path, and whether the chat's computer may change it. */
export interface Folder {
  readonly path: string;
  readonly readOnly: boolean;
}

export interface Grants {
  /** Folders in the order they were attached. Empty when never told one. */
  lookup(key: GrantKey): Effect.Effect<ReadonlyArray<Folder>>;
  /** Appends; a path already present keeps its place and takes the new mode. */
  remember(key: GrantKey, path: string, readOnly?: boolean): Effect.Effect<void>;
  /** Removes one path. */
  forget(key: GrantKey, path: string): Effect.Effect<void>;
  /** Removes every path under a key. */
  forgetAll(key: GrantKey): Effect.Effect<void>;
  /** Chats of this server with a folder attached. */
  chats(origin: string): Effect.Effect<ReadonlyArray<string>>;
}

/** A chat's folders as its computer mounts them, at `/folders/<name>`. */
export const mountsOf = (folders: ReadonlyArray<Folder>): Mount[] =>
  folders.map(({ path, readOnly }) => ({ name: folderName(path), hostPath: path, readOnly }));

export interface GrantKey {
  readonly origin: string;
  readonly conversationId: string;
}

/** An origin never contains a space; the id after it may contain anything. */
const encodeKey = ({ origin, conversationId }: GrantKey) => `${origin} ${conversationId}`;
/** Matches what `encodeKey` writes; older files used the bare id. */
const ENCODED_KEY = /^https?:\/\/\S+ ./;

const withFolder = (folders: ReadonlyArray<Folder>, folder: Folder) =>
  folders.some(({ path }) => path === folder.path)
    ? folders.map((existing) => (existing.path === folder.path ? folder : existing))
    : [...folders, folder];

/** A read-write folder is stored as its bare path, the shape files had before read-only existed. */
const stored = ({ path, readOnly }: Folder) => (readOnly ? { path, readOnly } : path);

/** Only paths survive: a hand-edited or corrupted file must not put a non-path into a mount. */
const parsed = (item: unknown): Folder | null => {
  if (typeof item === "string") return { path: item, readOnly: false };
  if (typeof item !== "object" || item === null) return null;
  const { path, readOnly } = item as Record<string, unknown>;
  return typeof path === "string" ? { path, readOnly: readOnly === true } : null;
};

/** The store's behaviour, shared by the persisted and the in-memory layers. */
const makeStore = (
  state: Map<string, ReadonlyArray<Folder>>,
  persist: Effect.Effect<void>,
): Grants => ({
  lookup: (key) => Effect.sync(() => state.get(encodeKey(key)) ?? []),
  remember: (key, path, readOnly = false) =>
    Effect.suspend(() => {
      const id = encodeKey(key);
      state.set(id, withFolder(state.get(id) ?? [], { path, readOnly }));
      return persist;
    }),
  forget: (key, path) =>
    Effect.suspend(() => {
      const id = encodeKey(key);
      const rest = (state.get(id) ?? []).filter((item) => item.path !== path);
      if (rest.length === 0) state.delete(id);
      else state.set(id, rest);
      return persist;
    }),
  forgetAll: (key) =>
    Effect.suspend(() => {
      state.delete(encodeKey(key));
      return persist;
    }),
  chats: (origin) =>
    Effect.sync(() =>
      [...state.keys()]
        .filter((id) => id.startsWith(`${origin} `))
        .map((id) => id.slice(origin.length + 1)),
    ),
});

export class GrantStore extends Context.Service<GrantStore, Grants>()("desktop/GrantStore") {
  static readonly layerAt = (file: string) =>
    Layer.effect(
      GrantStore,
      Effect.gen(function* () {
        const read = Effect.promise(async (): Promise<Array<[string, Folder[]]>> => {
          try {
            const contents: unknown = JSON.parse(await readFile(file, "utf8"));
            if (!contents || typeof contents !== "object") return [];
            const entries: Array<[string, Folder[]]> = [];
            for (const [id, value] of Object.entries(contents as Record<string, unknown>)) {
              if (!ENCODED_KEY.test(id) || !Array.isArray(value)) continue;
              const folders = value.map(parsed).filter((item) => item !== null);
              if (folders.length > 0) entries.push([id, folders]);
            }
            return entries;
          } catch {
            return [];
          }
        });

        const state = new Map<string, ReadonlyArray<Folder>>(yield* read);
        // Mutations are sync; writes are not. Each write stringifies the map
        // as it is by then, so the last one always holds the latest state.
        const queue = serialWrites();
        const persist = Effect.promise(() =>
          queue(() =>
            writeJsonAtomic(
              file,
              Object.fromEntries([...state].map(([id, folders]) => [id, folders.map(stored)])),
            ),
          ),
        );
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
