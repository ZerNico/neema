import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { Schema } from "effect";
import {
  BinaryContents,
  CommandOutput,
  DeleteReceipt,
  DesktopError,
  DirectoryListing,
  EditReceipt,
  FileContents,
  FolderStatus,
  FoundPaths,
  MoveReceipt,
  SandboxAvailability,
  SearchMatches,
  WriteReceipt,
} from "./schema.ts";

/**
 * Everything the site may ask of the machine it is running on.
 *
 * Two rules hold for every procedure here and are enforced on the desktop side,
 * never assumed from the caller:
 *
 * - Paths are relative to the attached folder. An absolute path, a `..` escape
 *   or a symlink leading outside resolves to `outside-folder`. The site names a
 *   path; the desktop decides whether it is reachable.
 * - The conversation id selects which folder applies, because a folder is
 *   attached per conversation and the mapping lives only on this machine.
 */
export const DesktopRpcs = RpcGroup.make(
  /** What the composer strip renders: attached, missing, or never picked. */
  Rpc.make("folderStatus", {
    payload: { conversationId: Schema.String },
    success: FolderStatus,
  }),

  /** Opens the native directory dialog. Cancelling yields `none`, not an error. */
  Rpc.make("chooseFolder", {
    payload: { conversationId: Schema.String },
    success: FolderStatus,
    error: DesktopError,
  }),

  Rpc.make("detachFolder", {
    payload: { conversationId: Schema.String },
    success: Schema.Void,
  }),

  /**
   * Moves a grant from one key to another, which is how a folder picked before
   * the first message survives: a new chat has no id yet, so the strip attaches
   * under a draft key and rebinds once the conversation exists.
   */
  Rpc.make("rebindFolder", {
    payload: { fromConversationId: Schema.String, toConversationId: Schema.String },
    success: FolderStatus,
  }),

  Rpc.make("listDirectory", {
    payload: { conversationId: Schema.String, path: Schema.String },
    success: DirectoryListing,
    error: DesktopError,
  }),

  Rpc.make("readFile", {
    payload: { conversationId: Schema.String, path: Schema.String },
    success: FileContents,
    error: DesktopError,
  }),

  Rpc.make("writeFile", {
    payload: {
      conversationId: Schema.String,
      path: Schema.String,
      text: Schema.String,
    },
    success: WriteReceipt,
    error: DesktopError,
  }),

  /** The raw bytes of an image or document, for a model that can take them. */
  Rpc.make("readBinary", {
    payload: { conversationId: Schema.String, path: Schema.String },
    success: BinaryContents,
    error: DesktopError,
  }),

  /**
   * Replaces `old` with `new` in a file. Exact match, and unless `all` is set,
   * exactly one occurrence: a fuzzy or first-match edit lands in the wrong
   * place quietly, and the model can widen its anchor when told to.
   */
  Rpc.make("editFile", {
    payload: {
      conversationId: Schema.String,
      path: Schema.String,
      old: Schema.String,
      new: Schema.String,
      all: Schema.Boolean,
    },
    success: EditReceipt,
    error: DesktopError,
  }),

  /** Renames or relocates within the folder. Never overwrites. */
  Rpc.make("movePath", {
    payload: { conversationId: Schema.String, from: Schema.String, to: Schema.String },
    success: MoveReceipt,
    error: DesktopError,
  }),

  /** Removes a file, or a directory and everything under it. */
  Rpc.make("deletePath", {
    payload: { conversationId: Schema.String, path: Schema.String },
    success: DeleteReceipt,
    error: DesktopError,
  }),

  /** Files whose path matches a glob, `.gitignore` respected. */
  Rpc.make("findFiles", {
    payload: { conversationId: Schema.String, pattern: Schema.String },
    success: FoundPaths,
    error: DesktopError,
  }),

  /** Lines matching a regular expression, `.gitignore` respected. */
  Rpc.make("searchFiles", {
    payload: {
      conversationId: Schema.String,
      pattern: Schema.String,
      /** Narrows to paths matching this glob; absent searches everything. */
      glob: Schema.optionalKey(Schema.String),
    },
    success: SearchMatches,
    error: DesktopError,
  }),

  Rpc.make("runCommand", {
    payload: {
      conversationId: Schema.String,
      /** Correlates the sandbox violation record with the tool call. */
      callId: Schema.String,
      command: Schema.String,
      timeoutMs: Schema.Int,
    },
    success: CommandOutput,
    error: DesktopError,
  }),

  /** Whether commands can run at all, and whether `setUpSandbox` could help. */
  Rpc.make("sandboxAvailability", { success: SandboxAvailability }),

  /** Windows only: the one-time elevated install. Re-checks and returns the new state. */
  Rpc.make("setUpSandbox", { success: SandboxAvailability, error: DesktopError }),

  /** Opens the folder in the platform file manager. */
  Rpc.make("revealPath", {
    payload: { conversationId: Schema.String, path: Schema.String },
    success: Schema.Void,
    error: DesktopError,
  }),
);

export type DesktopRpcs = typeof DesktopRpcs;
