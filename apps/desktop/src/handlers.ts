import { open, stat, type FileHandle } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { Effect } from "effect";
import {
  DesktopError,
  LIMITS,
  OPENABLE_EXTENSIONS,
  WORKSPACE_FOLDER_NAME,
  type ComputerStatus,
  type DesktopHandlers,
  type FolderStatus,
  type MachineHello,
  type RevealMode,
} from "@chat/desktop-rpc";
import type { ComputerSettings } from "./computer-settings.ts";
import { checkFolder } from "./computer/folder-access.ts";
import { guestRoot, place, WORKSPACE } from "./computer/paths.ts";
import { folderName, resolveInFolder } from "./folders.ts";
import { GrantStore, mountsOf } from "./grants.ts";
import { WorkspaceRegistry } from "./workspaces.ts";

/** What a reader can be shown as bytes: pictures and PDFs. */
const BINARY_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

/** A NUL in the first few kilobytes is what `file` and git use to call something binary. */
const isBinary = (bytes: Buffer) => bytes.subarray(0, 8_000).includes(0);

/** Electron and the rest of main, injected so tests need neither. */
export interface Shell {
  pickDirectory(): Promise<string | null>;
  /**
   * Hands a path this module has already proven contained to the operating
   * system. Resolves to the system's complaint, or null when it took the path.
   */
  revealPath(absolute: string, mode: RevealMode): Promise<string | null>;
  /** The server whose conversation ids these are; part of every grant key. */
  serverOrigin(): string;
  /** The app's own data, which no chat may be given as a folder. */
  readonly appData: string;
  executionSession(): { id: string; machineId: string; machineName: string };
  cancelCall(callId: string): boolean;
  setWorkState(state: { active: number; needsApproval: number }): void;
  /** Whether chats' VMs can run here, as the connected server hears it. */
  computer(): MachineHello["computer"];
  readonly settings: ComputerSettings;
  /** Remote control was switched; the server hears it. */
  remoteChanged(): void;
}

const failed = (message: string) => new DesktopError({ reason: "failed", message });

const alreadyAttached = (name: string) =>
  new DesktopError({
    reason: "already-exists",
    message: `A folder named ${name} is already attached. Rename one of them, or choose a different folder.`,
  });

const reservedName = new DesktopError({
  reason: "already-exists",
  message: `\`${WORKSPACE_FOLDER_NAME}\` is reserved for this chat's own workspace. Choose a differently named folder.`,
});

const openFailure = (guest: string) => (cause: unknown) => {
  const code = cause instanceof Error && "code" in cause ? cause.code : null;
  if (code === "ENOENT")
    return new DesktopError({ reason: "not-found", message: `${guest} does not exist.` });
  if (code === "EISDIR")
    return new DesktopError({ reason: "not-a-file", message: `${guest} is not a file.` });
  return failed(`Could not read ${guest}.`);
};

/** Bytes from the start of an open file, at most `max`. */
const readStart = async (handle: FileHandle, size: number, max: number) => {
  const length = Math.min(size, max);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = length === 0 ? { bytesRead: 0 } : await handle.read(buffer, 0, length, 0);
  return buffer.subarray(0, bytesRead);
};

const computerStatusOf = (shell: Shell): ComputerStatus => ({
  ...shell.computer(),
  ...shell.settings.get(),
});

export const makeHandlers = (shell: Shell) =>
  Effect.gen(function* () {
    const store = yield* GrantStore;
    const workspaces = yield* WorkspaceRegistry;
    // Every grant is looked up under the origin the shell is connected to, so
    // the handlers cannot forget to scope one.
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- key reads shell from the enclosing handler set
    const key = (conversationId: string) => ({ origin: shell.serverOrigin(), conversationId });

    /**
     * A guest path the page named, resolved on this machine inside the root it falls in: the
     * workspace, or the attached folder of that name. The computer writes in both and can plant
     * links, so the real path has to stay inside the root; an attached folder is also held to
     * still being where it was attached.
     */
    const locate = (conversationId: string, path: string) =>
      Effect.gen(function* () {
        const mounts = mountsOf(yield* store.lookup(key(conversationId)));
        const placed = place(path, mounts);
        if (!placed.ok)
          return yield* new DesktopError({
            reason: "outside-folder",
            message: `${path} is outside this chat's workspace and folders.`,
          });
        const mount = mounts.find((candidate) => guestRoot(candidate) === placed.root);
        const root = mount ? mount.hostPath : yield* workspaces.ensure(conversationId);
        const relative =
          placed.path === placed.root ? "." : placed.path.slice(placed.root.length + 1);
        const pinned = mount !== undefined;
        const resolved = yield* resolveInFolder(root, relative, pinned, placed.path);
        return { ...resolved, root, relative, pinned, guest: placed.path };
      });

    /**
     * Opens a contained regular file and hands it to `read`. Resolving and opening are two steps,
     * and a link swapped in between would be followed, so the opened file must be the very file
     * (device and inode) the path resolves to inside its root once it is open.
     */
    const withContainedFile = <A>(
      conversationId: string,
      path: string,
      read: (handle: FileHandle, size: number, guest: string) => Promise<A>,
    ) =>
      Effect.gen(function* () {
        const target = yield* locate(conversationId, path);
        return yield* Effect.acquireUseRelease(
          Effect.tryPromise({
            try: () => open(target.absolute, "r"),
            catch: openFailure(target.guest),
          }),
          (handle) =>
            Effect.gen(function* () {
              const opened = yield* Effect.tryPromise({
                try: () => handle.stat({ bigint: true }),
                catch: openFailure(target.guest),
              });
              if (!opened.isFile())
                return yield* new DesktopError({
                  reason: "not-a-file",
                  message: `${target.guest} is not a file.`,
                });
              const again = yield* resolveInFolder(
                target.root,
                target.relative,
                target.pinned,
                target.guest,
              );
              const there = yield* Effect.tryPromise({
                try: () => stat(again.absolute, { bigint: true }),
                catch: openFailure(target.guest),
              });
              if (there.dev !== opened.dev || there.ino !== opened.ino)
                return yield* new DesktopError({
                  reason: "outside-folder",
                  message: `${target.guest} changed while it was being read. Try again.`,
                });
              return yield* Effect.tryPromise({
                try: () => read(handle, Number(opened.size), target.guest),
                catch: (cause) =>
                  cause instanceof DesktopError ? cause : failed(`Could not read ${target.guest}.`),
              });
            }),
          (handle) => Effect.promise(() => handle.close().catch(() => {})),
        );
      });

    // A folder gone or replaced by a link is data inside the status, not a fault.
    const status = (conversationId: string): Effect.Effect<FolderStatus, DesktopError> =>
      Effect.gen(function* () {
        const folders = yield* store.lookup(key(conversationId));
        const listed = yield* Effect.forEach(mountsOf(folders), (mount) =>
          Effect.map(resolveInFolder(mount.hostPath, ".", true).pipe(Effect.result), (alive) => ({
            name: mount.name,
            path: guestRoot(mount),
            alive: alive._tag === "Success",
            readOnly: mount.readOnly,
          })),
        );
        return { folders: listed, workspace: { path: WORKSPACE } };
      });

    const handlers: DesktopHandlers = {
      folderStatus: ({ conversationId }) => status(conversationId),

      chooseFolder: ({ conversationId, replace, readOnly = false }) =>
        Effect.gen(function* () {
          const chosen = yield* Effect.tryPromise({
            try: () => shell.pickDirectory(),
            catch: () => failed("Could not open the folder picker."),
          });
          // Cancelling is an answer, not a fault: report what is attached now.
          if (chosen === null) return yield* status(conversationId);
          // Recorded by where it really is, which every later use holds it to.
          const checked = yield* Effect.tryPromise({
            try: () => checkFolder(chosen, shell.appData),
            catch: () => failed("Could not read that folder."),
          });
          if ("refused" in checked) return yield* failed(checked.refused);
          const picked = checked.path;
          // The workspace already answers to this name, so no user folder may.
          if (folderName(picked) === WORKSPACE_FOLDER_NAME) return yield* reservedName;
          // The name is how the computer addresses the folder, so two folders
          // with the same name cannot both be attached to one chat.
          let current = yield* store.lookup(key(conversationId));
          if (replace) {
            const match = current.find((folder) => folderName(folder.path) === replace);
            if (match && match.path !== picked) {
              yield* store.forget(key(conversationId), match.path);
              current = yield* store.lookup(key(conversationId));
            }
          }
          const clash = current.find(
            (folder) => folder.path !== picked && folderName(folder.path) === folderName(picked),
          );
          if (clash) {
            const alive = yield* resolveInFolder(clash.path, ".", true).pipe(Effect.result);
            if (alive._tag === "Success") return yield* alreadyAttached(folderName(picked));
            yield* store.forget(key(conversationId), clash.path);
          }
          yield* store.remember(key(conversationId), picked, readOnly);
          return yield* status(conversationId);
        }),

      detachFolder: ({ conversationId, name }) =>
        Effect.gen(function* () {
          // The workspace is app-managed; there is no detach for it.
          if (name === WORKSPACE_FOLDER_NAME) return yield* reservedName;
          const folders = yield* store.lookup(key(conversationId));
          const match = folders.find((folder) => folderName(folder.path) === name);
          if (match) yield* store.forget(key(conversationId), match.path);
          return yield* status(conversationId);
        }),

      executionSession: () => Effect.sync(() => shell.executionSession()),

      cancelCall: ({ callId }) =>
        Effect.try({
          try: () => shell.cancelCall(callId),
          catch: () =>
            failed("Could not retain this cancellation. Try again after active work finishes."),
        }),

      setWorkState: (state) => Effect.sync(() => shell.setWorkState(state)),

      saveToWorkspace: ({ conversationId, fileName, base64 }) =>
        Effect.gen(function* () {
          // Refused while it is still text, before decoding a huge payload.
          if (base64.length > Math.ceil(LIMITS.importBytes / 3) * 4 + 4)
            return yield* new DesktopError({
              reason: "too-large",
              message: "That file is too large to save to the workspace.",
            });
          const landed = yield* workspaces.landFile(
            conversationId,
            fileName,
            Buffer.from(base64, "base64"),
          );
          return { path: `${WORKSPACE}/${landed.name}`, created: true, bytes: landed.bytes };
        }),

      readFile: ({ conversationId, path }) =>
        withContainedFile(conversationId, path, async (handle, size, guest) => {
          const bytes = await readStart(handle, size, LIMITS.readBytes);
          // Decoding a binary file would show noise, never the file.
          if (isBinary(bytes))
            throw new DesktopError({ reason: "not-text", message: `${guest} is not a text file.` });
          const cut = size > bytes.length;
          // A cut can split the last character; its replacement mark is not the file's.
          const text = cut ? bytes.toString("utf8").replace(/�+$/u, "") : bytes.toString("utf8");
          return {
            path: guest,
            text: text.slice(0, LIMITS.readChars),
            truncated: cut || text.length > LIMITS.readChars,
          };
        }),

      readBinary: ({ conversationId, path }) => {
        const mediaType = BINARY_MEDIA_TYPES[extname(path).toLowerCase()];
        if (!mediaType)
          return Effect.fail(
            new DesktopError({
              reason: "not-binary",
              message: `${path} is not an image or a PDF.`,
            }),
          );
        return withContainedFile(conversationId, path, async (handle, size, guest) => {
          if (size > LIMITS.binaryBytes)
            throw new DesktopError({
              reason: "too-large",
              message: `${guest} is larger than ${LIMITS.binaryBytes / 1024 / 1024} MB.`,
            });
          const bytes = await readStart(handle, size, LIMITS.binaryBytes);
          return { path: guest, mediaType, base64: bytes.toString("base64"), bytes: bytes.length };
        });
      },

      fileInfo: ({ conversationId, path }) =>
        withContainedFile(conversationId, path, async (_handle, size, guest) => ({
          path: guest,
          bytes: size,
        })),

      revealPath: ({ conversationId, path, mode }) =>
        Effect.gen(function* () {
          const target = yield* locate(conversationId, path);
          // `showItemInFolder` reports nothing about a path that is not there,
          // so the reader would get silence. Ask first and say so instead.
          const info = yield* Effect.tryPromise({
            try: () => stat(target.absolute),
            catch: () =>
              new DesktopError({ reason: "not-found", message: `${target.guest} does not exist.` }),
          });
          // The execute bit catches what the extension list cannot: a file of
          // a listed kind that a command chmod-ed. The site offers Open only
          // for the list, so this is the case a reader meets.
          const executable = info.isFile() && (info.mode & 0o111) !== 0;
          const listed = OPENABLE_EXTENSIONS.has(extname(target.absolute).toLowerCase());
          if (mode === "open" && (executable || !listed))
            return yield* new DesktopError({
              reason: "not-openable",
              message: executable
                ? `${target.guest} is marked executable, so opening it could run it. Show it in the folder instead.`
                : `${target.guest} is not a kind of file the app opens directly. Show it in the folder instead.`,
            });
          const complaint = yield* Effect.tryPromise({
            try: () => shell.revealPath(target.absolute, mode),
            catch: () => failed(`Could not open ${target.guest}.`),
          });
          if (complaint !== null) return yield* failed(`Could not open ${target.guest}.`);
        }),

      computerStatus: () => Effect.sync(() => computerStatusOf(shell)),

      setRemoteControl: ({ enabled }) =>
        Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () => shell.settings.set({ remote: enabled }),
            catch: () => failed("Could not save the setting."),
          });
          shell.remoteChanged();
          return computerStatusOf(shell);
        }),

      setAgentSocket: ({ path }) =>
        Effect.gen(function* () {
          if (path !== null) {
            if (!isAbsolute(path) || path.includes("\0"))
              return yield* failed("Name the agent's socket by its full path.");
            // Windows' agents are named pipes, which have no file to look at.
            if (process.platform !== "win32") {
              const info = yield* Effect.promise(() => stat(path).catch(() => null));
              if (!info?.isSocket()) return yield* failed(`No agent is listening at ${path}.`);
            }
          }
          yield* Effect.tryPromise({
            try: () => shell.settings.set({ agentSocket: path }),
            catch: () => failed("Could not save the setting."),
          });
          return computerStatusOf(shell);
        }),
    };

    return handlers;
  });
