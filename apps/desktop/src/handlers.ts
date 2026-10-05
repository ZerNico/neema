import { open, readdir, readFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { conflictsWithNetworkGrants, normalizeNetworkGrant } from "./network-grants.ts";
import { Effect } from "effect";
import {
  DesktopError,
  LIMITS,
  UNOPENABLE_EXTENSIONS,
  WORKSPACE_FOLDER_NAME,
  type DeleteFailure,
  type DesktopHandlers,
  type DirectoryEntry,
  type FolderStatus,
  type RevealMode,
  type SearchMatch,
} from "@chat/desktop-rpc";
import { unifiedDiff } from "./diff.ts";
import { GrantStore } from "./grants.ts";
import { WorkspaceRegistry } from "./workspaces.ts";
import { exists, folderName, resolveAmongRoots, resolveInFolder } from "./folders.ts";
import { Sandbox } from "./sandbox.ts";
import { ripgrepAvailable, searchWithRipgrep } from "./ripgrep.ts";
import { globToRegExp, globMatches, walkFiles } from "./walk.ts";

/** What a model can be handed as bytes: images for vision, PDFs for documents. */
const BINARY_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

/** What an import may bring in for server tools: pictures to place, Office files to edit. */
const IMPORT_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
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
  /** The server whose conversation ids these are; part of every grant key. */
  serverOrigin(): string;
  executionSession(): { id: string; machineId: string; machineName: string };
  cancelCall(callId: string): boolean;
  setWorkState(state: { active: number; needsApproval: number }): void;
  networkGrantsDirectory?: string;
}

const alreadyAttached = (name: string) =>
  new DesktopError({
    reason: "already-exists",
    message: `A folder named ${name} is already attached. Rename one of them, or choose a different folder.`,
  });

const reservedName = new DesktopError({
  reason: "already-exists",
  message: `\`${WORKSPACE_FOLDER_NAME}\` is reserved for this chat's own workspace. Choose a differently named folder.`,
});

const deleteFailureReason = (reason: DesktopError["reason"]): DeleteFailure["reason"] =>
  reason === "outside-folder" || reason === "not-found" || reason === "no-folder"
    ? reason
    : "failed";

export const makeHandlers = (shell: Shell) =>
  Effect.gen(function* () {
    const store = yield* GrantStore;
    const sandbox = yield* Sandbox;
    const workspaces = yield* WorkspaceRegistry;
    // Every grant is looked up under the origin the shell is connected to, so
    // the handlers cannot forget to scope one.
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- key reads shell from the enclosing handler set
    const key = (conversationId: string) => ({ origin: shell.serverOrigin(), conversationId });
    const grants = {
      lookup: (conversationId: string) => store.lookup(key(conversationId)),
      remember: (conversationId: string, folder: string) =>
        store.remember(key(conversationId), folder),
      forget: (conversationId: string, folder: string) => store.forget(key(conversationId), folder),
    };

    /**
     * The roots the model can address, workspace first: name for receipts and
     * the strip, real path for containment and the sandbox allowlist. A work
     * chat always has at least its own workspace, so the tools never meet an
     * empty world.
     */
    const rootsFor = (conversationId: string) =>
      Effect.map(grants.lookup(conversationId), (folders) => [
        { name: WORKSPACE_FOLDER_NAME, root: workspaces.path(conversationId) },
        ...folders.map((folder) => ({ name: folderName(folder), root: folder })),
      ]);

    /**
     * A model path, absolute on disk, resolved inside the root that owns it.
     * Receipts name it back as `workspace/src/index.ts`, the short form the
     * transcript shows; the address the model sends is always the real path.
     *
     * The workspace root is ensured first: it is created on demand, so
     * resolving against the bare path would fail for a chat whose first touch
     * is a write, and a path under a nonexistent workspace must not fall
     * through to a grant that happens to share a prefix.
     */
    const locate = (conversationId: string, path: string) =>
      Effect.gen(function* () {
        yield* workspaces.ensure(conversationId);
        const roots = yield* rootsFor(conversationId);
        return yield* resolveAmongRoots(roots, path);
      });

    const locateForWrite = (conversationId: string, path: string) =>
      Effect.gen(function* () {
        const target = yield* locate(conversationId, path);
        if (
          shell.networkGrantsDirectory &&
          conflictsWithNetworkGrants(shell.networkGrantsDirectory, target.absolute)
        ) {
          return yield* Effect.fail(
            new DesktopError({
              reason: "outside-folder",
              message: "That path contains desktop network permissions.",
            }),
          );
        }
        return target;
      });

    /** One path from a batch. A folder root is the owner's to detach, never to delete. */
    const removeAt = (conversationId: string, path: string) =>
      Effect.gen(function* () {
        const target = yield* locate(conversationId, path);
        // `resolveInFolder` against the root yields `relative: "."`; across
        // folders it is the prefixed name. Either way, the root itself is not
        // a delete target.
        if (target.absolute === target.root || !target.relative.includes("/")) {
          return yield* Effect.fail(
            new DesktopError({
              reason: "outside-folder",
              message: "The folder itself cannot be deleted.",
            }),
          );
        }
        yield* locateForWrite(conversationId, path);
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
      });

    // Dead grants and sandbox availability are data inside the status, not faults.
    const status = (conversationId: string): Effect.Effect<FolderStatus, DesktopError> =>
      Effect.gen(function* () {
        const folders = yield* grants.lookup(conversationId);
        const listed = yield* Effect.forEach(folders, (folder) =>
          // A remembered folder can have been moved, renamed or deleted since.
          // Resolving its own root is the cheapest proof that it is still there.
          Effect.map(resolveInFolder(folder, ".").pipe(Effect.result), (alive) => ({
            name: folderName(folder),
            path: folder,
            alive: alive._tag === "Success",
          })),
        );
        return {
          folders: listed,
          sandbox: yield* sandbox.availability(),
          workspace: { path: workspaces.path(conversationId) },
        };
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
          // The workspace already answers to this name, so no user folder may.
          if (folderName(picked) === WORKSPACE_FOLDER_NAME) return yield* reservedName;
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
          // The workspace is app-managed; there is no detach for it.
          if (name === WORKSPACE_FOLDER_NAME) return yield* reservedName;
          const folders = yield* grants.lookup(conversationId);
          const match = folders.find((folder) => folderName(folder) === name);
          if (match) yield* grants.forget(conversationId, match);
          return yield* status(conversationId);
        }),

      stageFile: ({ conversationId, submissionId, fileName, base64 }) =>
        Effect.gen(function* () {
          // Refuse before decoding, while the oversized payload is still text.
          if (base64.length > Math.ceil(LIMITS.importBytes / 3) * 4 + 4) {
            return yield* new DesktopError({
              reason: "too-large",
              message: "That file is too large to add to the workspace.",
            });
          }
          return yield* workspaces.stageFile(
            conversationId,
            submissionId,
            fileName,
            Buffer.from(base64, "base64"),
          );
        }),

      discardStagedFile: ({ conversationId, submissionId, name }) =>
        workspaces.discardStagedFile(conversationId, submissionId, name),

      discardSubmission: ({ conversationId, submissionId }) =>
        workspaces.discardSubmission(conversationId, submissionId),

      promoteSubmission: ({ conversationId, submissionId, reservationId }) =>
        workspaces.promote(conversationId, submissionId, reservationId),

      commitPromotion: ({ conversationId, reservationId }) =>
        workspaces.commit(conversationId, reservationId),

      rollbackPromotion: ({ conversationId, reservationId }) =>
        workspaces.rollback(conversationId, reservationId),

      listPendingPromotions: () => workspaces.pendingPromotions(),

      cloneWorkspace: ({ fromConversationId, toConversationId }) =>
        workspaces.clone(fromConversationId, toConversationId),

      copyFolderGrants: ({ fromConversationId, toConversationId }) =>
        Effect.gen(function* () {
          const folders = yield* grants.lookup(fromConversationId);
          const dest = yield* grants.lookup(toConversationId);
          for (const folder of folders) {
            const clash = dest.find(
              (existing) => existing !== folder && folderName(existing) === folderName(folder),
            );
            if (clash) return yield* Effect.fail(alreadyAttached(folderName(folder)));
          }
          // Copy, never move: the source conversation keeps its folders.
          for (const folder of folders) yield* grants.remember(toConversationId, folder);
          return yield* status(toConversationId);
        }),

      discardWorkspace: ({ conversationId }) => workspaces.discard(conversationId),

      listDirectory: ({ conversationId, path }) =>
        Effect.gen(function* () {
          if (path === "." || path === "") {
            // The root of the model's world is the list of roots it may
            // address, by their real paths.
            const roots = yield* rootsFor(conversationId);
            return {
              path: ".",
              entries: roots.map(({ root }) => ({
                name: root,
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

      fileInfo: ({ conversationId, path }) =>
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
          return { path: target.relative, bytes: info.size };
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

      readBinary: ({ conversationId, path, purpose }) =>
        Effect.gen(function* () {
          const target = yield* locate(conversationId, path);
          const importing = purpose === "import";
          const mediaType = (importing ? IMPORT_MEDIA_TYPES : BINARY_MEDIA_TYPES)[
            extname(target.relative).toLowerCase()
          ];
          if (!mediaType) {
            return yield* Effect.fail(
              new DesktopError({
                reason: "not-binary",
                message: importing
                  ? `${target.relative} is not a PNG, JPEG, PowerPoint (.pptx), Excel (.xlsx) or Word (.docx) file.`
                  : `${target.relative} is not an image or a PDF.`,
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
                message: `${target.relative} is larger than ${LIMITS.binaryBytes / 1024 / 1024} MB.`,
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
          const target = yield* locateForWrite(conversationId, path);
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
          const source = yield* locateForWrite(conversationId, from);
          const destination = yield* locateForWrite(conversationId, to);
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

      deletePath: ({ conversationId, paths }) =>
        Effect.gen(function* () {
          // Per-path misses stay in the receipt so one missing file does not
          // abort the rest.
          yield* rootsFor(conversationId);
          const deleted: { path: string; kind: "file" | "directory" }[] = [];
          const failed: DeleteFailure[] = [];
          for (const path of new Set(paths)) {
            const outcome = yield* Effect.result(removeAt(conversationId, path));
            if (outcome._tag === "Success") deleted.push(outcome.success);
            else
              failed.push({
                path,
                reason: deleteFailureReason(outcome.failure.reason),
                message: outcome.failure.message,
              });
          }
          return { deleted, failed };
        }),

      findFiles: ({ conversationId, pattern }) =>
        Effect.gen(function* () {
          const roots = yield* rootsFor(conversationId);
          // Each root answers for itself; the cap applies to the union so a
          // big first folder cannot hide the second entirely.
          const perRoot = Math.max(1, Math.floor(LIMITS.foundPaths / roots.length));
          let paths: string[] = [];
          let truncated = false;
          for (const { root } of roots) {
            const matcher = yield* Effect.try({
              try: () => globToRegExp(pattern),
              catch: () =>
                new DesktopError({ reason: "bad-pattern", message: `Could not read ${pattern}.` }),
            });
            const resolved = yield* resolveInFolder(root, ".").pipe(Effect.result);
            if (resolved._tag === "Failure") continue;
            // Walker, not rg: `--files` never names a directory, so a glob like
            // `**/*extracted*` would miss `DVR/extracted_images/` and every file
            // inside it whose own name does not match.
            const walked = yield* Effect.promise(() =>
              walkFiles(
                resolved.success.absolute,
                WALK_LIMIT,
                (rel) => globMatches(matcher, rel),
                (rel) => matcher.test(rel),
              ),
            );
            // Newest first: the file just changed is the one being asked about.
            const sorted = walked.files.toSorted((a, b) => b.mtimeMs - a.mtimeMs);
            // The absolute path is the address the model sends back, so the
            // result lists those, not the display form. A directory's relative
            // ends in `/`; keep the mark on the absolute form too.
            paths.push(
              ...sorted
                .slice(0, perRoot)
                .map((file) => (file.relative.endsWith("/") ? `${file.absolute}/` : file.absolute)),
            );
            truncated ||= walked.truncated || sorted.length > perRoot;
          }
          if (paths.length > LIMITS.foundPaths) {
            paths = paths.slice(0, LIMITS.foundPaths);
            truncated = true;
          }
          return { pattern, paths, truncated };
        }),

      searchFiles: ({ conversationId, pattern, glob }) =>
        Effect.gen(function* () {
          const roots = yield* rootsFor(conversationId);
          const regex = yield* Effect.try({
            try: () => new RegExp(pattern),
            catch: () =>
              new DesktopError({
                reason: "bad-pattern",
                message: `${pattern} is not a valid regular expression.`,
              }),
          });
          const matches: SearchMatch[] = [];
          let filesSearched = 0;
          let truncated = false;
          for (const { root } of roots) {
            if (matches.length >= LIMITS.matches) {
              truncated = true;
              break;
            }
            const resolved = yield* resolveInFolder(root, ".").pipe(Effect.result);
            if (resolved._tag === "Failure") continue;
            if (yield* Effect.promise(ripgrepAvailable)) {
              const fast = yield* searchWithRipgrep(resolved.success.absolute, pattern, glob);
              for (const hit of fast.matches) {
                if (matches.length >= LIMITS.matches) {
                  truncated = true;
                  break;
                }
                // rg reports root-relative paths; the model's address is the
                // absolute one.
                matches.push({ ...hit, path: join(resolved.success.absolute, hit.path) });
              }
              filesSearched += fast.filesSearched;
              truncated ||= fast.truncated;
              continue;
            }
            const matcher = glob
              ? yield* Effect.try({
                  try: () => globToRegExp(glob),
                  catch: () =>
                    new DesktopError({ reason: "bad-pattern", message: `Could not read ${glob}.` }),
                })
              : null;
            const walked = yield* Effect.promise(() =>
              walkFiles(resolved.success.absolute, WALK_LIMIT, (rel) =>
                matcher ? matcher.test(rel) : true,
              ),
            );
            truncated ||= walked.truncated;
            for (const file of walked.files) {
              if (matches.length >= LIMITS.matches) {
                truncated = true;
                break;
              }
              const loaded = yield* readPrefix(file.absolute, LIMITS.readBytes, file.relative).pipe(
                Effect.result,
              );
              if (loaded._tag === "Failure" || isBinary(loaded.success)) continue;
              filesSearched += 1;
              const lines = loaded.success.toString("utf8").split("\n");
              for (let index = 0; index < lines.length; index += 1) {
                const line = lines[index]!;
                if (!regex.test(line)) continue;
                matches.push({
                  path: file.absolute,
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
          const target = yield* locateForWrite(conversationId, path);
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

      saveToWorkspace: ({ conversationId, fileName, base64, path }) =>
        Effect.gen(function* () {
          // Same ceiling as a composer import, refused while it is still text.
          if (base64.length > Math.ceil(LIMITS.importBytes / 3) * 4 + 4) {
            return yield* new DesktopError({
              reason: "too-large",
              message: "That file is too large to save to the workspace.",
            });
          }
          if (path !== undefined) {
            // A chosen place: inside the chat's roots, exactly like a write.
            const target = yield* locateForWrite(conversationId, path);
            const existed = yield* exists(target.absolute);
            const data = Buffer.from(base64, "base64");
            yield* Effect.tryPromise({
              try: async () => {
                await mkdir(dirname(target.absolute), { recursive: true });
                await writeFile(target.absolute, data);
              },
              catch: () =>
                new DesktopError({
                  reason: "failed",
                  message: `Could not save ${target.relative}.`,
                }),
            });
            // Absolute, like the workspace landing: the model links files by it.
            return { path: target.absolute, created: !existed, bytes: data.byteLength };
          }
          const landed = yield* workspaces.landFile(
            conversationId,
            fileName,
            Buffer.from(base64, "base64"),
          );
          return {
            path: join(workspaces.path(conversationId), landed.name),
            created: true,
            bytes: landed.bytes,
          };
        }),

      runCommand: ({ conversationId, callId, command, timeoutMs }) =>
        Effect.gen(function* () {
          const roots = yield* rootsFor(conversationId);
          // The command starts in this chat's workspace; every attached folder
          // is writable too, so `cd` and `cp` between them just work.
          const cwd = yield* workspaces.ensure(conversationId);
          const allowed = yield* Effect.forEach(roots, ({ root }) =>
            Effect.map(resolveInFolder(root, ".").pipe(Effect.result), (resolved) =>
              resolved._tag === "Success" ? resolved.success.absolute : null,
            ),
          );
          return yield* sandbox.run({
            callId,
            command,
            cwd,
            allowWrite: allowed.filter((root): root is string => root !== null),
            timeoutMs,
          });
        }),

      requestNetworkAccess: ({ host }) =>
        Effect.gen(function* () {
          const grant = normalizeNetworkGrant(host);
          if (!grant) {
            return yield* Effect.fail(
              new DesktopError({
                reason: "failed",
                message: "Enter one exact public hostname without a URL or port.",
              }),
            );
          }
          yield* sandbox.approveNetwork(grant);
          return grant;
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
