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
  FileInfo,
  FolderStatus,
  FoundPaths,
  LIMITS,
  MoveReceipt,
  RevealMode,
  SandboxAvailability,
  SearchMatches,
  WriteReceipt,
} from "./schema.ts";

const deletedPathsMax = LIMITS.deletedPaths;

/**
 * Everything the site may ask of the machine it is running on.
 *
 * Two rules hold for every procedure here and are enforced on the desktop side,
 * never assumed from the caller:
 *
 * - A path is absolute and resolves, through realpath, inside the chat's
 *   workspace or an attached folder. Anything else, a `..` escape or a
 *   symlink leading outside, resolves to `outside-folder`. The site names a
 *   path; the desktop decides whether it is reachable.
 * - The conversation id selects which folders apply, because folders are
 *   attached per conversation and the mapping lives only on this machine.
 */
export const DesktopRpcs = RpcGroup.make(
  /** What the composer strip renders: every attached folder and whether it is still there. */
  Rpc.make("folderStatus", {
    payload: { conversationId: Schema.String },
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
      conversationId: Schema.String,
      /** Detach this name first, so a relocated folder can reclaim it. */
      replace: Schema.optionalKey(Schema.String),
    },
    success: FolderStatus,
    error: DesktopError,
  }),

  Rpc.make("detachFolder", {
    payload: { conversationId: Schema.String, name: Schema.String },
    success: FolderStatus,
  }),

  /**
   * Moves the grants from one key to another, which is how folders picked
   * before the first message survive: a new chat has no id yet, so the strip
   * attaches under a draft key and rebinds once the conversation exists.
   */
  Rpc.make("rebindFolder", {
    payload: { fromConversationId: Schema.String, toConversationId: Schema.String },
    success: FolderStatus,
  }),

  /**
   * The run-scoped executor id plus this machine's stable identity. The id
   * changes every launch; `machineId` survives restarts but not a reinstall,
   * which is exactly what the "this chat last worked elsewhere" banner keys
   * on. Names are display text only, never an address.
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
  Rpc.make("setWorkState", {
    payload: {
      active: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      needsApproval: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    },
    success: Schema.Void,
  }),

  Rpc.make("listDirectory", {
    payload: {
      conversationId: Schema.String,
      path: Schema.String,
      callId: Schema.String,
    },
    success: DirectoryListing,
    error: DesktopError,
  }),

  Rpc.make("readFile", {
    payload: {
      conversationId: Schema.String,
      path: Schema.String,
      callId: Schema.String,
    },
    success: FileContents,
    error: DesktopError,
  }),

  /** Size alone, for a preview that needs the dialog's facts without the bytes. */
  Rpc.make("fileInfo", {
    payload: {
      conversationId: Schema.String,
      path: Schema.String,
      callId: Schema.String,
    },
    success: FileInfo,
    error: DesktopError,
  }),

  Rpc.make("writeFile", {
    payload: {
      conversationId: Schema.String,
      callId: Schema.String,
      path: Schema.String,
      text: Schema.String,
    },
    success: WriteReceipt,
    error: DesktopError,
  }),

  /** The raw bytes of an image or document, for a model that can take them. */
  Rpc.make("readBinary", {
    payload: {
      conversationId: Schema.String,
      path: Schema.String,
      callId: Schema.String,
    },
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
      callId: Schema.String,
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
    payload: {
      conversationId: Schema.String,
      from: Schema.String,
      to: Schema.String,
      callId: Schema.String,
    },
    success: MoveReceipt,
    error: DesktopError,
  }),

  /**
   * Removes files or directories (recursively). One call is one confirmation;
   * a missing path does not stop the rest. Conversation-level refusals
   * (`no-folder`) still fail the procedure.
   */
  Rpc.make("deletePath", {
    payload: {
      conversationId: Schema.String,
      paths: Schema.Array(Schema.String).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(deletedPathsMax),
      ),
      callId: Schema.String,
    },
    success: DeleteReceipt,
    error: DesktopError,
  }),

  /** Files whose path matches a glob, `.gitignore` respected. */
  Rpc.make("findFiles", {
    payload: {
      conversationId: Schema.String,
      pattern: Schema.String,
      callId: Schema.String,
    },
    success: FoundPaths,
    error: DesktopError,
  }),

  /** Lines matching a regular expression, `.gitignore` respected. */
  Rpc.make("searchFiles", {
    payload: {
      conversationId: Schema.String,
      callId: Schema.String,
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
      /**
       * Run in the chat's workspace. Paths inside the command are absolute;
       * the sandbox allows reads and writes inside the workspace and every
       * attached folder, so `cd` and `cp` between them work.
       */
      command: Schema.String,
      /**
       * How long the desktop lets the command run. The page derives it from
       * the server's deadline for the call, so a command never outlives the
       * wait that would accept its result.
       */
      timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
    },
    success: CommandOutput,
    error: DesktopError,
  }),

  /**
   * Shows a file where it lives, or hands it to the application that owns its
   * extension.
   *
   * The only procedure here the model cannot reach: it carries no `callId`,
   * so it is outside the replay ledger and the call deadline, and nothing it
   * does reaches the transcript. The reader clicked a row on the authorized
   * page. Containment is still the desktop's to prove, because that page is
   * remote code whichever side of it named the path.
   *
   * `open` refuses a file this computer would execute. Choosing the handler by
   * extension is what `openPath` does, so a `.command` the model wrote is one
   * click from running; `reveal` answers for those instead.
   */
  Rpc.make("revealPath", {
    payload: {
      conversationId: Schema.String,
      path: Schema.String,
      mode: RevealMode,
    },
    success: Schema.Void,
    error: DesktopError,
  }),

  /** Windows only: the one-time elevated install. Re-checks and returns the new state. */
  Rpc.make("setUpSandbox", { success: SandboxAvailability, error: DesktopError }),

  /**
   * The remaining procedures are user-driven, not model calls: no `callId`,
   * no replay ledger, no approval. The composer's own confirmation (a chip
   * the user can remove) is the consent, and the workspace is the app's own
   * container, so nothing here crosses a trust boundary the picker would
   * have added.
   */

  /**
   * Writes a file the user pasted into the chat's workspace, by sanitized
   * basename at its root. Binary (base64, capped at `LIMITS.importBytes`
   * decoded), any type: only some are readable back by the model, and the
   * rest still matter to commands. Drops with a local path use
   * `importFileFromPath`, which moves no bytes over the bridge.
   */
  Rpc.make("importFile", {
    payload: {
      conversationId: Schema.String,
      fileName: Schema.String,
      base64: Schema.String,
    },
    success: WriteReceipt,
    error: DesktopError,
  }),

  /**
   * Copies a dropped file from where it already lives on this machine into
   * the chat's workspace, capped at `LIMITS.importPathBytes`. The path comes
   * from the drop event, which is the user's own consent; the copy is
   * contained to the workspace root all the same.
   */
  Rpc.make("importFileFromPath", {
    payload: {
      conversationId: Schema.String,
      fileName: Schema.String,
      sourcePath: Schema.String,
    },
    success: WriteReceipt,
    error: DesktopError,
  }),

  /** Removes a file `importFile` just placed, when its chip is removed. */
  Rpc.make("discardImport", {
    payload: { conversationId: Schema.String, name: Schema.String },
    success: Schema.Void,
    error: DesktopError,
  }),

  /**
   * Copies the workspace of one conversation onto another: how a branch keeps
   * its local files. Refuses a non-empty destination rather than merging into
   * whatever the destination's lazy creation already holds.
   */
  Rpc.make("cloneWorkspace", {
    payload: { fromConversationId: Schema.String, toConversationId: Schema.String },
    success: Schema.Void,
    error: DesktopError,
  }),

  /**
   * Remembers the source conversation's folder grants under the destination
   * too. Copy, not move: `rebindFolder` empties the source, which is the
   * draft flow's contract and would be wrong for a branch.
   */
  Rpc.make("copyFolderGrants", {
    payload: { fromConversationId: Schema.String, toConversationId: Schema.String },
    success: FolderStatus,
    error: DesktopError,
  }),

  /**
   * Removes a conversation's workspace directory. Best-effort from the
   * delete-conversation action; nothing on the server waits for it.
   */
  Rpc.make("discardWorkspace", {
    payload: { conversationId: Schema.String },
    success: Schema.Void,
    error: DesktopError,
  }),
);

export type DesktopRpcs = typeof DesktopRpcs;
