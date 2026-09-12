import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { Context, Effect, Layer } from "effect";
import type { NetworkLevel } from "@chat/desktop-rpc";

/**
 * Which folder belongs to which conversation, on this machine.
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
export interface Grant {
  /** Absolute path of the folder. */
  readonly folder: string;
  readonly network: NetworkLevel;
}

export interface Grants {
  /** The grant, or null when this machine has never been told a folder. */
  lookup(conversationId: string): Effect.Effect<Grant | null>;
  /** Keeps the network level if one was set before; a new folder starts at packages. */
  remember(conversationId: string, folder: string): Effect.Effect<void>;
  setNetwork(conversationId: string, level: NetworkLevel): Effect.Effect<void>;
  forget(conversationId: string): Effect.Effect<void>;
}

const DEFAULT_NETWORK: NetworkLevel = "packages";

const isLevel = (value: unknown): value is NetworkLevel =>
  value === "none" || value === "packages" || value === "all";

/** Reads both the old `{ id: path }` shape and the current `{ id: grant }`. */
const parseGrant = (value: unknown): Grant | null => {
  if (typeof value === "string") return { folder: value, network: DEFAULT_NETWORK };
  if (!value || typeof value !== "object") return null;
  const { folder, network } = value as { folder?: unknown; network?: unknown };
  if (typeof folder !== "string") return null;
  return { folder, network: isLevel(network) ? network : DEFAULT_NETWORK };
};

export class GrantStore extends Context.Service<GrantStore, Grants>()("desktop/GrantStore") {
  static readonly layerAt = (file: string) =>
    Layer.effect(
      GrantStore,
      Effect.gen(function* () {
        const read = Effect.promise(async (): Promise<Array<[string, Grant]>> => {
          try {
            const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
            if (!parsed || typeof parsed !== "object") return [];
            // Only well-formed entries survive: a hand-edited or corrupted file
            // must not put a non-path into the containment check.
            const entries: Array<[string, Grant]> = [];
            for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
              const grant = parseGrant(value);
              if (grant) entries.push([id, grant]);
            }
            return entries;
          } catch {
            return [];
          }
        });

        const state = new Map<string, Grant>(yield* read);

        const persist = Effect.promise(async () => {
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, JSON.stringify(Object.fromEntries(state), null, 2), "utf8");
        });

        return GrantStore.of({
          lookup: (conversationId) => Effect.sync(() => state.get(conversationId) ?? null),
          remember: (conversationId, folder) =>
            Effect.suspend(() => {
              const network = state.get(conversationId)?.network ?? DEFAULT_NETWORK;
              state.set(conversationId, { folder, network });
              return persist;
            }),
          setNetwork: (conversationId, level) =>
            Effect.suspend(() => {
              const current = state.get(conversationId);
              if (current) state.set(conversationId, { ...current, network: level });
              return persist;
            }),
          forget: (conversationId) =>
            Effect.suspend(() => {
              state.delete(conversationId);
              return persist;
            }),
        });
      }),
    );

  /** In-memory, for tests and for a shell running without a writable profile. */
  static readonly layerEphemeral = Layer.effect(
    GrantStore,
    Effect.sync(() => {
      const state = new Map<string, Grant>();
      return GrantStore.of({
        lookup: (id) => Effect.sync(() => state.get(id) ?? null),
        remember: (id, folder) =>
          Effect.sync(() => {
            const network = state.get(id)?.network ?? DEFAULT_NETWORK;
            state.set(id, { folder, network });
          }),
        setNetwork: (id, level) =>
          Effect.sync(() => {
            const current = state.get(id);
            if (current) state.set(id, { ...current, network: level });
          }),
        forget: (id) => Effect.sync(() => void state.delete(id)),
      });
    }),
  );
}

/** What the strip under the composer shows. Never the absolute path. */
export const folderLabel = (folder: string) => basename(folder) || folder;

export const grantsFile = (userData: string) => join(userData, "folders.json");
