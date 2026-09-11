import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { Schema } from "effect";
import {
  CommandOutput,
  DesktopError,
  DirectoryListing,
  FileContents,
  FolderStatus,
  SandboxAvailability,
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
