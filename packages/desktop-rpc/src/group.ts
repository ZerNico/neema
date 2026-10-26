import { Rpc, RpcGroup } from "effect/rpc";
import { Schema } from "effect";
import {
  BinaryContents,
  ComputerStatus,
  DesktopError,
  FileContents,
  FileInfo,
  FolderStatus,
  RevealMode,
  WorkspaceId,
  WriteReceipt,
} from "./schema.ts";

/**
 * Everything the site may ask of the machine it is running on. The chat's own tools do not run
 * here: the machine runs them in the chat's computer, called by the server (`machine.ts`).
 *
 * Two rules hold for every procedure here and are enforced on the desktop side,
 * never assumed from the caller:
 *
 * - A path is a guest path, `/workspace/...` or `/folders/<name>/...`, and resolves, through
 *   realpath on this machine, inside the chat's workspace or that attached folder. A `..`
 *   escape or a link the computer planted leading outside resolves to `outside-folder`. The
 *   site names a path; the desktop decides whether it is reachable.
 * - The conversation id selects which folders apply, because folders are
 *   attached per conversation and the mapping lives only on this machine.
 */
export const DesktopRpcs = RpcGroup.make(
  /** What the composer strip renders: every attached folder and whether it is still there. */
  Rpc.make("folderStatus", {
    payload: { conversationId: WorkspaceId },
    success: FolderStatus,
  }),

  /**
   * Opens the native directory dialog and adds the choice. Cancelling changes
   * nothing. A live folder whose name is already attached is refused with
   * `already-exists`. `replace` detaches that name first, which is how a
   * relocated folder reclaims its address.
   */
  Rpc.make("chooseFolder", {
    payload: {
      conversationId: WorkspaceId,
      /** Detach this name first, so a relocated folder can reclaim it. */
      replace: Schema.optionalKey(Schema.String),
      /** The computer may read the folder but not change it. False when absent. */
      readOnly: Schema.optionalKey(Schema.Boolean),
    },
    success: FolderStatus,
    error: DesktopError,
  }),

  Rpc.make("detachFolder", {
    payload: { conversationId: WorkspaceId, name: Schema.String },
    success: FolderStatus,
    error: DesktopError,
  }),

  /**
   * The browser executor: the page runs the model's browser calls in this app's embedded
   * browser. The id changes every launch; `machineId` survives restarts but not a reinstall.
   * Names are display text only, never an address.
   */
  Rpc.make("executionSession", {
    success: Schema.Struct({
      id: Schema.String,
      machineId: Schema.String,
      machineName: Schema.String,
    }),
  }),
  Rpc.make("cancelCall", {
    payload: { callId: Schema.String },
    success: Schema.Boolean,
    error: DesktopError,
  }),
  /** Browser calls running and waiting, for the tray, the dock badge and quitting. */
  Rpc.make("setWorkState", {
    payload: {
      active: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      needsApproval: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    },
    success: Schema.Void,
  }),

  /**
   * Lands bytes a browser call fetched in the chat's workspace, under a collision-free name. A
   * model operation, so it carries a callId and is retained: replaying it must not land the file
   * twice. The receipt names the guest path, `/workspace/<name>`. There is no chosen place: the
   * computer can move links into a folder while the host writes, so the host only adds new names.
   */
  Rpc.make("saveToWorkspace", {
    payload: {
      conversationId: WorkspaceId,
      callId: Schema.String,
      fileName: Schema.String,
      base64: Schema.String,
    },
    success: WriteReceipt,
    error: DesktopError,
  }),

  /**
   * The remaining previews and actions are the reader's, on a file the transcript names: no
   * callId, no replay ledger, no call deadline, and nothing reaches the transcript. Containment
   * is still the desktop's to prove, because the page is remote code whichever side of it named
   * the path.
   */

  /** Text, capped at `LIMITS.readChars`. */
  Rpc.make("readFile", {
    payload: {
      conversationId: WorkspaceId,
      path: Schema.String,
    },
    success: FileContents,
    error: DesktopError,
  }),

  /** The raw bytes of an image or PDF, for a person to look at. */
  Rpc.make("readBinary", {
    payload: {
      conversationId: WorkspaceId,
      path: Schema.String,
    },
    success: BinaryContents,
    error: DesktopError,
  }),

  /** Size alone, for a preview that needs the dialog's facts without the bytes. */
  Rpc.make("fileInfo", {
    payload: {
      conversationId: WorkspaceId,
      path: Schema.String,
    },
    success: FileInfo,
    error: DesktopError,
  }),

  /**
   * Shows a file where it lives, or hands it to the application that owns its
   * extension.
   *
   * `open` refuses a file this computer would execute. Choosing the handler by
   * extension is what `openPath` does, so a `.command` the model wrote is one
   * click from running; `reveal` answers for those instead.
   */
  Rpc.make("revealPath", {
    payload: {
      conversationId: WorkspaceId,
      path: Schema.String,
      mode: RevealMode,
    },
    success: Schema.Void,
    error: DesktopError,
  }),

  /** Settings › This computer: whether chats' computers can run here, and its settings. */
  Rpc.make("computerStatus", { success: ComputerStatus }),

  /** Lets calls started on the person's other devices run here, or stops them. */
  Rpc.make("setRemoteControl", {
    payload: { enabled: Schema.Boolean },
    success: ComputerStatus,
    error: DesktopError,
  }),

  /** The SSH agent socket chats may be allowed to use; null goes back to the default. */
  Rpc.make("setAgentSocket", {
    payload: { path: Schema.NullOr(Schema.String) },
    success: ComputerStatus,
    error: DesktopError,
  }),
);

export type DesktopRpcs = typeof DesktopRpcs;
