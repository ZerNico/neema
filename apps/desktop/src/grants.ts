import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { Context, Effect, Layer } from "effect";

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
export interface Grants {
  /** Absolute path, or null when this machine has never been told one. */
  lookup(conversationId: string): Effect.Effect<string | null>;
  remember(conversationId: string, folder: string): Effect.Effect<void>;
  forget(conversationId: string): Effect.Effect<void>;
}

/** Reads the current `{ id: path }` shape and the short-lived `{ id: { folder } }` one. */
const parseFolder = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const folder = (value as { folder?: unknown }).folder;
  return typeof folder === "string" ? folder : null;
};

export class GrantStore extends Context.Service<GrantStore, Grants>()("desktop/GrantStore") {
  static readonly layerAt = (file: string) =>
    Layer.effect(
      GrantStore,
      Effect.gen(function* () {
        const read = Effect.promise(async (): Promise<Array<[string, string]>> => {
          try {
            const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
            if (!parsed || typeof parsed !== "object") return [];
            // Only paths survive: a hand-edited or corrupted file must not put
            // a non-path into the containment check.
            const entries: Array<[string, string]> = [];
            for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
              const folder = parseFolder(value);
              if (folder) entries.push([id, folder]);
            }
            return entries;
          } catch {
            return [];
          }
        });

        const state = new Map<string, string>(yield* read);

        const persist = Effect.promise(async () => {
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, JSON.stringify(Object.fromEntries(state), null, 2), "utf8");
        });

        return GrantStore.of({
          lookup: (conversationId) => Effect.sync(() => state.get(conversationId) ?? null),
          remember: (conversationId, folder) =>
            Effect.suspend(() => {
              state.set(conversationId, folder);
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
      const state = new Map<string, string>();
      return GrantStore.of({
        lookup: (id) => Effect.sync(() => state.get(id) ?? null),
        remember: (id, folder) => Effect.sync(() => void state.set(id, folder)),
        forget: (id) => Effect.sync(() => void state.delete(id)),
      });
    }),
  );
}

/** What the strip under the composer shows. Never the absolute path. */
export const folderLabel = (folder: string) => basename(folder) || folder;

export const grantsFile = (userData: string) => join(userData, "folders.json");
