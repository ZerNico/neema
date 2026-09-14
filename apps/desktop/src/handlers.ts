import { open, readdir, readFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { Effect } from "effect";
import {
  DesktopError,
  LIMITS,
  UNOPENABLE_EXTENSIONS,
  type DesktopHandlers,
  type DirectoryEntry,
  type FolderStatus,
  type RevealMode,
  type SearchMatch,
} from "@chat/desktop-rpc";
import { unifiedDiff } from "./diff.ts";
import { GrantStore } from "./grants.ts";
import { exists, folderName, resolveAcross, resolveInFolder } from "./folders.ts";
import { Sandbox } from "./sandbox.ts";
import { findWithRipgrep, searchWithRipgrep } from "./ripgrep.ts";
import { globToRegExp, walkFiles } from "./walk.ts";

/** What a model can be handed as bytes: images for vision, PDFs for documents. */
const BINARY_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

/** Files visited before a find or search gives up. Visited, not returned. */
const WALK_LIMIT = 50_000;

const isBinary = (bytes: Buffer) => bytes.subarray(0, 8_000).includes(0);

/** Bytes already proven to be a regular file, capped so a huge log cannot OOM us. */
const readPrefix = (absolute: string, maxBytes: number, relative: string) =>
  Effect.tryPromise({
    try: async () => {
      const handle = await open(absolute, "r");
      try {
        const length = Math.min(maxBytes, (await handle.stat()).size);
        if (length === 0) return Buffer.alloc(0);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, 0);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
    catch: () =>
      new DesktopError({
        reason: "failed",
        message: `Could not read ${relative}.`,
      }),
  });

/**
 * The desktop side of the contract. Every procedure that touches disk goes
 * through `resolveInFolder` first, so the containment check is not something a
 * handler can forget: there is no other way to turn a requested path into an
 * absolute one here.
 */

/** The native directory dialog, injected so tests need no Electron. */
export interface Shell {
  pickDirectory(): Promise<string | null>;
  /**
   * Hands a path this module has already proven contained to the operating
   * system. Resolves to the system's complaint, or null when it took the path.
   */
  revealPath(absolute: string, mode: RevealMode): Promise<string | null>;
  executionSession(): { id: string };
  cancelCall(callId: string): boolean;
  setWorkState(state: { active: number; needsApproval: number }): void;
}

const noFolder = new DesktopError({
  reason: "no-folder",
  message: "No folder is attached to this chat on this computer.",
});

/** Which segment of a many-folder path is the folder, for the name the model sees back. */
const prefixed = (folder: string, relative: string) =>
  relative === "." ? folder : `${folder}/${relative}`;

const alreadyAttached = (name: string) =>
  new DesktopError({
    reason: "already-exists",
    message: `A folder named ${name} is already attached. Rename one of them, or choose a different folder.`,
  });

/**
 * A glob may name a folder (`site/**`). Strip that so it applies inside the
 * folder it names and skips the others. Find and search share this so a
 * pattern like `workspace` plus nested files is not searched as a nested path.
 */
const globScope = (
  glob: string | undefined,
  name: string,
  folders: ReadonlyArray<string>,
): { glob: string | undefined; skip: boolean } => {
  if (!glob) return { glob: undefined, skip: false };
  const [head, ...rest] = glob.split("/");
  if (!folders.some((folder) => folderName(folder) === head)) return { glob, skip: false };
  return head === name
    ? { glob: rest.join("/") || undefined, skip: false }
    : { glob, skip: true };
};

export const makeHandlers = (shell: Shell) =>
  Effect.gen(function* () {
    const grants = yield* GrantStore;
    const sandbox = yield* Sandbox;

    /** The attached folders, or a refusal. Used by everything that touches disk. */
    const foldersFor = (conversationId: string) =>
      Effect.flatMap(grants.lookup(conversationId), (folders) =>
        folders.length === 0 ? Effect.fail(noFolder) : Effect.succeed(folders),
      );

    /** A model path, `site/src/index.ts`, resolved inside the folder it names. */
    const locate = (conversationId: string, path: string) =>
      Effect.flatMap(foldersFor(conversationId), (folders) => resolveAcross(folders, path));

    const status = (conversationId: string): Effect.Effect<FolderStatus> =>
      Effect.gen(function* () {
        const folders = yield* grants.lookup(conversationId);
        const listed = yield* Effect.forEach(folders, (folder) =>
          // A remembered folder can have been moved, renamed or deleted since.
          // Resolving its own root is the cheapest proof that it is still there.
          Effect.map(resolveInFolder(folder, ".").pipe(Effect.result), (alive) => ({
            name: folderName(folder),
            alive: alive._tag === "Success",
          })),
        );
        return { folders: listed, sandbox: yield* sandbox.availability() };
      });

    const handlers: DesktopHandlers = {
      executionSession: () => Effect.sync(() => shell.executionSession()),
      cancelCall: ({ callId }) =>
        Effect.try({
          try: () => shell.cancelCall(callId),
          catch: () =>
            new DesktopError({
              reason: "failed",
              message: "Could not retain this cancellation. Try again after active work finishes.",
            }),
        }),
      setWorkState: (state) => Effect.sync(() => shell.setWorkState(state)),
      folderStatus: ({ conversationId }) => status(conversationId),

      chooseFolder: ({ conversationId, replace }) =>
        Effect.gen(function* () {
          const picked = yield* Effect.tryPromise({
            try: () => shell.pickDirectory(),
            catch: () =>
              new DesktopError({ reason: "failed", message: "Could not open the folder picker." }),
          });
          // Cancelling is an answer, not a fault: report what is attached now.
          if (picked === null) return yield* status(conversationId);
          // The name is how the model addresses the folder, so two folders
          // with the same name cannot both be attached to one chat.
          let current = yield* grants.lookup(conversationId);
          if (replace) {
            const match = current.find((folder) => folderName(folder) === replace);
            if (match && match !== picked) {
              yield* grants.forget(conversationId, match);
              current = yield* grants.lookup(conversationId);
            }
          }
          const clash = current.find(
            (folder) => folder !== picked && folderName(folder) === folderName(picked),
          );
          if (clash) {
            const alive = yield* resolveInFolder(clash, ".").pipe(Effect.result);
            if (alive._tag === "Success")
              return yield* Effect.fail(alreadyAttached(folderName(picked)));
            yield* grants.forget(conversationId, clash);
          }
          yield* grants.remember(conversationId, picked);
          return yield* status(conversationId);
        }),

      detachFolder: ({ conversationId, name }) =>
        Effect.gen(function* () {
          const folders = yield* grants.lookup(conversationId);
          const match = folders.find((folder) => folderName(folder) === name);
          if (match) yield* grants.forget(conversationId, match);
          return yield* status(conversationId);
        }),

      rebindFolder: ({ fromConversationId, toConversationId }) =>
        Effect.gen(function* () {
          const folders = yield* grants.lookup(fromConversationId);
          const dest = yield* grants.lookup(toConversationId);
          // Same rule as choose: the name is the address, so two folders that
          // share one cannot both sit on the destination.
          for (const folder of folders) {
            const clash = dest.find(
              (existing) => existing !== folder && folderName(existing) === folderName(folder),
            );
            if (clash) return yield* Effect.fail(alreadyAttached(folderName(folder)));
          }
          // Nothing under the draft key is the ordinary case: the chat was
          // started without picking a folder first.
          for (const folder of folders) yield* grants.remember(toConversationId, folder);
          if (folders.length > 0) yield* grants.forgetAll(fromConversationId);
          return yield* status(toConversationId);
        }),

      listDirectory: ({ conversationId, path }) =>
        Effect.gen(function* () {
          if (path === "." || path === "") {
            // The root of the model's world is the list of attached folders.
            const folders = yield* foldersFor(conversationId);
            return {
              path: ".",
              entries: folders.map((folder) => ({
                name: folderName(folder),
                kind: "directory" as const,
              })),
              truncated: false,
            };
          }
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
          // A size beside every plain file is what lets the model tell an
          // empty file from a folder without a second call to find out.
          const entries: DirectoryEntry[] = yield* Effect.forEach(kept, (entry) =>
            Effect.gen(function* () {
              const kind = entry.isDirectory()
                ? ("directory" as const)
                : entry.isSymbolicLink()
                  ? ("symlink" as const)
                  : entry.isFile()
                    ? ("file" as const)
                    : ("other" as const);
              if (kind !== "file") return { name: entry.name, kind };
              const size = yield* Effect.promise(() =>
                stat(join(target.absolute, entry.name)).then(
                  (info) => info.size,
                  () => null,
                ),
              );
              return size === null ? { name: entry.name, kind } : { name: entry.name, kind, size };
            }),
          );
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
          const bytes = yield* readPrefix(target.absolute, LIMITS.readBytes, target.relative);
          // A NUL in the first few kilobytes is what `file` and git use to
          // call something binary. Decoding it anyway would hand the model
          // noise and the server a string Postgres refuses.
          if (isBinary(bytes)) {
            return yield* Effect.fail(
              new DesktopError({
                reason: "not-text",
                message: `${target.relative} is not a text file.`,
              }),
            );
          }
          const text = bytes.toString("utf8");
          // Capped here rather than at the caller: an uncapped read would go
          // into the transcript and, on models without native tool calling,
          // into the prompt as prose.
          const truncated = text.length > LIMITS.readChars || info.size > bytes.length;
          return {
            path: target.relative,
            text: truncated ? text.slice(0, LIMITS.readChars) : text,
            truncated,
          };
        }),

      readBinary: ({ conversationId, path }) =>
        Effect.gen(function* () {
          const target = yield* locate(conversationId, path);
          const mediaType = BINARY_MEDIA_TYPES[extname(target.relative).toLowerCase()];
          if (!mediaType) {
            return yield* Effect.fail(
              new DesktopError({
                reason: "not-binary",
                message: `${target.relative} is not an image or a PDF.`,
              }),
            );
          }
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
          if (info.size > LIMITS.binaryBytes) {
            return yield* Effect.fail(
              new DesktopError({
                reason: "too-large",
                message: `${target.relative} is too large to send to the model.`,
              }),
            );
          }
          const bytes = yield* Effect.tryPromise({
            try: () => readFile(target.absolute),
            catch: () =>
              new DesktopError({
                reason: "failed",
                message: `Could not read ${target.relative}.`,
              }),
          });
          return {
            path: target.relative,
            mediaType,
            base64: bytes.toString("base64"),
            bytes: bytes.length,
          };
        }),

      editFile: ({ conversationId, path, old: before, new: after, all }) =>
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
          if (info.size > LIMITS.writeBytes) {
            return yield* Effect.fail(
              new DesktopError({
                reason: "too-large",
                message: `${target.relative} is too large to edit.`,
              }),
            );
          }
          const bytes = yield* readPrefix(target.absolute, LIMITS.writeBytes, target.relative);
          if (isBinary(bytes)) {
            return yield* Effect.fail(
              new DesktopError({
                reason: "not-text",
                message: `${target.relative} is not a text file.`,
              }),
            );
          }
          const text = bytes.toString("utf8");
          if (before === "") {
            return yield* Effect.fail(
              new DesktopError({
                reason: "no-match",
                message: "The text to replace must not be empty.",
              }),
            );
          }
          // Exact, and unique unless told otherwise. Guessing at whitespace or
          // taking the first hit would land an edit somewhere the model did not
          // look; a sharp refusal it can act on is the safer answer.
          const first = text.indexOf(before);
          if (first === -1) {
            return yield* Effect.fail(
              new DesktopError({
                reason: "no-match",
                message: `The text to replace was not found in ${target.relative}. It must match exactly, whitespace included.`,
              }),
            );
          }
          const second = text.indexOf(before, first + before.length);
          if (second !== -1 && !all) {
            return yield* Effect.fail(
              new DesktopError({
                reason: "ambiguous-match",
                message: `The text to replace appears more than once in ${target.relative}. Include more surrounding lines so it is unique, or set all to replace every occurrence.`,
              }),
            );
          }
          const next = all
            ? text.replaceAll(before, () => after)
            : text.replace(before, () => after);
          const replacements = all ? text.split(before).length - 1 : 1;
          yield* Effect.tryPromise({
            try: () => writeFile(target.absolute, next, "utf8"),
            catch: () =>
              new DesktopError({
                reason: "failed",
                message: `Could not write ${target.relative}.`,
              }),
          });
          const preview = unifiedDiff(target.relative, text, next);
          const diff = preview.diff;
          const truncated = preview.truncated || diff.length > LIMITS.readChars;
          return {
            path: target.relative,
            replacements,
            diff: truncated ? diff.slice(0, LIMITS.readChars) : diff,
            truncated,
          };
        }),

      movePath: ({ conversationId, from, to }) =>
        Effect.gen(function* () {
          // Both ends are contained: a move is a read of one path and a write
          // of another, and either could be the one that escapes.
          const source = yield* locate(conversationId, from);
          const destination = yield* locate(conversationId, to);
          yield* Effect.tryPromise({
            try: () => stat(source.absolute),
            catch: () =>
              new DesktopError({
                reason: "not-found",
                message: `${source.relative} does not exist.`,
              }),
          });
          const taken = yield* exists(destination.absolute);
          if (taken) {
            return yield* Effect.fail(
              new DesktopError({
                reason: "already-exists",
                message: `${destination.relative} already exists. Delete it first if you mean to replace it.`,
              }),
            );
          }
          yield* Effect.tryPromise({
            try: async () => {
              await mkdir(dirname(destination.absolute), { recursive: true });
              await rename(source.absolute, destination.absolute);
            },
            catch: () =>
              new DesktopError({
                reason: "failed",
                message: `Could not move ${source.relative} to ${destination.relative}.`,
              }),
          });
          return { from: source.relative, to: destination.relative };
        }),

      deletePath: ({ conversationId, path }) =>
        Effect.gen(function* () {
          const target = yield* locate(conversationId, path);
          // A bare folder name is the folder itself, which is the user's to
          // detach, never the model's to delete.
          if (target.absolute === target.root) {
            return yield* Effect.fail(
              new DesktopError({
                reason: "outside-folder",
                message: "The folder itself cannot be deleted.",
              }),
            );
          }
          const info = yield* Effect.tryPromise({
            try: () => stat(target.absolute),
            catch: () =>
              new DesktopError({
                reason: "not-found",
                message: `${target.relative} does not exist.`,
              }),
          });
          const kind = info.isDirectory() ? ("directory" as const) : ("file" as const);
          yield* Effect.tryPromise({
            try: () => rm(target.absolute, { recursive: kind === "directory" }),
            catch: () =>
              new DesktopError({
                reason: "failed",
                message: `Could not delete ${target.relative}.`,
              }),
          });
          return { path: target.relative, kind };
        }),

      findFiles: ({ conversationId, pattern }) =>
        Effect.gen(function* () {
          const folders = yield* foldersFor(conversationId);
          // Each folder answers for itself; the cap applies to the union so a
          // big first folder cannot hide the second entirely.
          const perFolder = Math.max(1, Math.floor(LIMITS.foundPaths / folders.length));
          let paths: string[] = [];
          let truncated = false;
          for (const folder of folders) {
            const name = folderName(folder);
            const scope = globScope(pattern, name, folders);
            if (scope.skip) continue;
            const inner = scope.glob ?? "*";
            const matcher = yield* Effect.try({
              try: () => globToRegExp(inner),
              catch: () =>
                new DesktopError({ reason: "bad-pattern", message: `Could not read ${pattern}.` }),
            });
            const root = yield* resolveInFolder(folder, ".").pipe(Effect.result);
            if (root._tag === "Failure") continue;
            const fast = yield* findWithRipgrep(root.success.absolute, scope.glob);
            if (fast) {
              paths.push(...fast.paths.slice(0, perFolder).map((rel) => prefixed(name, rel)));
              truncated ||= fast.truncated || fast.paths.length > perFolder;
              continue;
            }
            const walked = yield* Effect.promise(() =>
              walkFiles(root.success.absolute, WALK_LIMIT, (rel) => matcher.test(rel)),
            );
            // Newest first: the file just changed is the one being asked about.
            const sorted = walked.files.sort((a, b) => b.mtimeMs - a.mtimeMs);
            paths.push(...sorted.slice(0, perFolder).map((file) => prefixed(name, file.relative)));
            truncated ||= walked.truncated || sorted.length > perFolder;
          }
          if (paths.length > LIMITS.foundPaths) {
            paths = paths.slice(0, LIMITS.foundPaths);
            truncated = true;
          }
          return { pattern, paths, truncated };
        }),

      searchFiles: ({ conversationId, pattern, glob }) =>
        Effect.gen(function* () {
          const folders = yield* foldersFor(conversationId);
          const regex = yield* Effect.try({
            try: () => new RegExp(pattern),
            catch: () =>
              new DesktopError({
                reason: "bad-pattern",
                message: `${pattern} is not a valid regular expression.`,
              }),
          });
          const badPattern = () =>
            new DesktopError({
              reason: "bad-pattern",
              message: `${pattern} is not a valid regular expression.`,
            });
          const matches: SearchMatch[] = [];
          let filesSearched = 0;
          let truncated = false;
          for (const folder of folders) {
            if (matches.length >= LIMITS.matches) {
              truncated = true;
              break;
            }
            const name = folderName(folder);
            const scope = globScope(glob, name, folders);
            if (scope.skip) continue;
            const root = yield* resolveInFolder(folder, ".").pipe(Effect.result);
            if (root._tag === "Failure") continue;
            const fast = yield* searchWithRipgrep(root.success.absolute, pattern, scope.glob).pipe(
              Effect.mapError(badPattern),
            );
            if (fast) {
              for (const hit of fast.matches) {
                if (matches.length >= LIMITS.matches) {
                  truncated = true;
                  break;
                }
                matches.push({ ...hit, path: prefixed(name, hit.path) });
              }
              filesSearched += fast.filesSearched;
              truncated ||= fast.truncated;
              continue;
            }
            const matcher = scope.glob ? globToRegExp(scope.glob) : null;
            const walked = yield* Effect.promise(() =>
              walkFiles(root.success.absolute, WALK_LIMIT, (rel) =>
                matcher ? matcher.test(rel) : true,
              ),
            );
            truncated ||= walked.truncated;
            for (const file of walked.files) {
              if (matches.length >= LIMITS.matches) {
                truncated = true;
                break;
              }
              const loaded = yield* readPrefix(
                file.absolute,
                LIMITS.readBytes,
                file.relative,
              ).pipe(Effect.result);
              if (loaded._tag === "Failure" || isBinary(loaded.success)) continue;
              filesSearched += 1;
              const lines = loaded.success.toString("utf8").split("\n");
              for (let index = 0; index < lines.length; index += 1) {
                const line = lines[index]!;
                if (!regex.test(line)) continue;
                matches.push({
                  path: prefixed(name, file.relative),
                  line: index + 1,
                  text: line.length > LIMITS.matchChars ? line.slice(0, LIMITS.matchChars) : line,
                });
                if (matches.length >= LIMITS.matches) {
                  truncated = true;
                  break;
                }
              }
            }
          }
          return { pattern, matches, filesSearched, truncated };
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
          const existed = yield* exists(target.absolute);
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

      runCommand: ({ conversationId, callId, command, folder, timeoutMs, network }) =>
        Effect.gen(function* () {
          const folders = yield* foldersFor(conversationId);
          // The named folder is the cwd; every attached folder is writable, so
          // a script in one can reach another by its prefixed path.
          const cwd = yield* locate(conversationId, folder);
          const roots = yield* Effect.forEach(folders, (item) =>
            Effect.map(resolveInFolder(item, ".").pipe(Effect.result), (root) =>
              root._tag === "Success" ? root.success.absolute : null,
            ),
          );
          return yield* sandbox.run({
            callId,
            command,
            cwd: cwd.absolute,
            allowWrite: roots.filter((root): root is string => root !== null),
            timeoutMs,
            network,
          });
        }),

      revealPath: ({ conversationId, path, mode }) =>
        Effect.gen(function* () {
          const target = yield* locate(conversationId, path);
          // `showItemInFolder` reports nothing about a path that is not there,
          // so the reader would get silence. Ask first and say so instead.
          const info = yield* Effect.tryPromise({
            try: () => stat(target.absolute),
            catch: () =>
              new DesktopError({
                reason: "not-found",
                message: `${target.relative} does not exist.`,
              }),
          });
          // The execute bit catches what the extension list cannot: a script
          // with no extension, or one a command the model ran chmod-ed. The
          // site hides its Open button for the list, so this is the case a
          // reader actually meets.
          const executable = info.isFile() && (info.mode & 0o111) !== 0;
          const listed = UNOPENABLE_EXTENSIONS.has(extname(target.absolute).toLowerCase());
          if (mode === "open" && (executable || listed)) {
            return yield* Effect.fail(
              new DesktopError({
                reason: "not-openable",
                message: executable
                  ? `${target.relative} is marked executable, so opening it could run it. Show it in the folder instead.`
                  : `${target.relative} is a kind of file that can run when it is opened. Show it in the folder instead.`,
              }),
            );
          }
          const complaint = yield* Effect.tryPromise({
            try: () => shell.revealPath(target.absolute, mode),
            catch: () =>
              new DesktopError({
                reason: "failed",
                message: `Could not open ${target.relative}.`,
              }),
          });
          if (complaint !== null) {
            return yield* Effect.fail(
              new DesktopError({ reason: "failed", message: `Could not open ${target.relative}.` }),
            );
          }
        }),

      setUpSandbox: () => sandbox.setUp(),
    };

    return handlers;
  });
