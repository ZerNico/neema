import { readdir, readFile, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect } from "effect";
import {
  DesktopError,
  LIMITS,
  type DesktopHandlers,
  type DirectoryEntry,
  type FolderStatus,
} from "@chat/desktop-rpc";
import { folderLabel, GrantStore } from "./grants.ts";
import { resolveInFolder } from "./folders.ts";
import { Sandbox } from "./sandbox.ts";

/**
 * The desktop side of the contract. Every procedure that touches disk goes
 * through `resolveInFolder` first, so the containment check is not something a
 * handler can forget: there is no other way to turn a requested path into an
 * absolute one here.
 */

/** Native dialog and file-manager reveal, injected so tests need no Electron. */
export interface Shell {
  pickDirectory(): Promise<string | null>;
  reveal(absolute: string): Promise<void>;
}

const noFolder = new DesktopError({
  reason: "no-folder",
  message: "No folder is attached to this chat on this computer.",
});

export const makeHandlers = (shell: Shell) =>
  Effect.gen(function* () {
    const grants = yield* GrantStore;
    const sandbox = yield* Sandbox;

    /** The attached folder, or a refusal. Used by everything that touches disk. */
    const folderFor = (conversationId: string) =>
      Effect.flatMap(grants.lookup(conversationId), (folder) =>
        folder === null ? Effect.fail(noFolder) : Effect.succeed(folder),
      );

    const locate = (conversationId: string, path: string) =>
      Effect.flatMap(folderFor(conversationId), (folder) => resolveInFolder(folder, path));

    const status = (conversationId: string): Effect.Effect<FolderStatus> =>
      Effect.gen(function* () {
        const folder = yield* grants.lookup(conversationId);
        if (folder === null) return { kind: "none" } as const;
        // A remembered folder can have been moved, renamed or deleted since.
        // Resolving its own root is the cheapest proof that it is still there.
        const alive = yield* resolveInFolder(folder, ".").pipe(Effect.result);
        if (alive._tag === "Failure") {
          return { kind: "unresolved", name: folderLabel(folder) } as const;
        }
        return {
          kind: "attached",
          name: folderLabel(folder),
          sandbox: yield* sandbox.availability(),
        } as const;
      });

    const handlers: DesktopHandlers = {
      folderStatus: ({ conversationId }) => status(conversationId),

      chooseFolder: ({ conversationId }) =>
        Effect.gen(function* () {
          const picked = yield* Effect.tryPromise({
            try: () => shell.pickDirectory(),
            catch: () =>
              new DesktopError({ reason: "failed", message: "Could not open the folder picker." }),
          });
          // Cancelling is an answer, not a fault: report what is attached now.
          if (picked === null) return yield* status(conversationId);
          yield* grants.remember(conversationId, picked);
          return yield* status(conversationId);
        }),

      detachFolder: ({ conversationId }) => grants.forget(conversationId),

      listDirectory: ({ conversationId, path }) =>
        Effect.gen(function* () {
          const target = yield* locate(conversationId, path);
          const found = yield* Effect.tryPromise({
            try: () => readdir(target.absolute, { withFileTypes: true }),
            catch: () =>
              new DesktopError({
                reason: "not-a-directory",
                message: `${target.relative} is not a directory.`,
              }),
          });
          const kept = found.slice(0, LIMITS.entries);
          const entries: DirectoryEntry[] = kept.map((entry) => ({
            name: entry.name,
            kind: entry.isDirectory()
              ? ("directory" as const)
              : entry.isSymbolicLink()
                ? ("symlink" as const)
                : entry.isFile()
                  ? ("file" as const)
                  : ("other" as const),
          }));
          return {
            path: target.relative,
            entries,
            truncated: found.length > kept.length,
          };
        }),

      readFile: ({ conversationId, path }) =>
        Effect.gen(function* () {
          const target = yield* locate(conversationId, path);
          const info = yield* Effect.tryPromise({
            try: () => stat(target.absolute),
            catch: () =>
              new DesktopError({
                reason: "not-found",
                message: `${target.relative} does not exist.`,
              }),
          });
          if (!info.isFile()) {
            return yield* Effect.fail(
              new DesktopError({
                reason: "not-a-file",
                message: `${target.relative} is not a file.`,
              }),
            );
          }
          const text = yield* Effect.tryPromise({
            try: () => readFile(target.absolute, "utf8"),
            catch: () =>
              new DesktopError({
                reason: "failed",
                message: `Could not read ${target.relative}.`,
              }),
          });
          // Capped here rather than at the caller: an uncapped read would go
          // into the transcript and, on models without native tool calling,
          // into the prompt as prose.
          const truncated = text.length > LIMITS.readChars;
          return {
            path: target.relative,
            text: truncated ? text.slice(0, LIMITS.readChars) : text,
            truncated,
          };
        }),

      writeFile: ({ conversationId, path, text }) =>
        Effect.gen(function* () {
          const bytes = Buffer.byteLength(text, "utf8");
          if (bytes > LIMITS.writeBytes) {
            return yield* Effect.fail(
              new DesktopError({
                reason: "too-large",
                message: "That file is too large to write.",
              }),
            );
          }
          const target = yield* locate(conversationId, path);
          const existed = yield* Effect.promise(() =>
            stat(target.absolute).then(
              () => true,
              () => false,
            ),
          );
          yield* Effect.tryPromise({
            try: async () => {
              await mkdir(dirname(target.absolute), { recursive: true });
              await writeFile(target.absolute, text, "utf8");
            },
            catch: () =>
              new DesktopError({
                reason: "failed",
                message: `Could not write ${target.relative}.`,
              }),
          });
          return { path: target.relative, created: !existed, bytes };
        }),

      runCommand: ({ conversationId, callId, command, timeoutMs }) =>
        Effect.gen(function* () {
          const folder = yield* folderFor(conversationId);
          // The folder root is the cwd, and the only writable path the sandbox
          // is given for this call.
          const root = yield* resolveInFolder(folder, ".");
          return yield* sandbox.run({ callId, command, cwd: root.absolute, timeoutMs });
        }),

      sandboxAvailability: () => sandbox.availability(),

      setUpSandbox: () => sandbox.setUp(),

      revealPath: ({ conversationId, path }) =>
        Effect.gen(function* () {
          const target = yield* locate(conversationId, path);
          yield* Effect.tryPromise({
            try: () => shell.reveal(target.absolute),
            catch: () =>
              new DesktopError({ reason: "failed", message: "Could not open that folder." }),
          });
        }),
    };

    return handlers;
  });
