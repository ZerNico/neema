import { Rpc, RpcGroup } from "effect/rpc";
import { Schema } from "effect";
import {
  BinaryContents,
  ChatPermission,
  ChatPermissions,
  Capability,
  CommandOutput,
  DeleteReceipt,
  DesktopError,
  DirectoryListing,
  EditReceipt,
  FileContents,
  FileInfo,
  FolderStatus,
  FoundPaths,
  GrantScope,
  LIMITS,
  LocalTransactionId,
  MoveReceipt,
  NetworkPermission,
  NetworkPort,
  PendingPromotion,
  PromotionReceipt,
  RevealMode,
  SandboxAvailability,
  SearchMatches,
  StagedFileReceipt,
  WorkspaceId,
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
    },
    success: FolderStatus,
    error: DesktopError,
  }),

  Rpc.make("detachFolder", {
    payload: { conversationId: WorkspaceId, name: Schema.String },
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
      /** The answers still running; network grants scoped to any other answer end. */
      attempts: Schema.Array(
        Schema.Struct({ conversationId: Schema.String, generationId: Schema.String }),
      ),
    },
    success: Schema.Void,
  }),

  Rpc.make("listDirectory", {
    payload: {
      conversationId: WorkspaceId,
      path: Schema.String,
      callId: Schema.String,
    },
    success: DirectoryListing,
    error: DesktopError,
  }),

  Rpc.make("readFile", {
    payload: {
      conversationId: WorkspaceId,
      path: Schema.String,
      callId: Schema.String,
      /** The first line to read, counting from 1. */
      offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
      /** How many lines to read at most. */
      limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    },
    success: FileContents,
    error: DesktopError,
  }),

  /** Size alone, for a preview that needs the dialog's facts without the bytes. */
  Rpc.make("fileInfo", {
    payload: {
      conversationId: WorkspaceId,
      path: Schema.String,
      callId: Schema.String,
    },
    success: FileInfo,
    error: DesktopError,
  }),

  Rpc.make("writeFile", {
    payload: {
      conversationId: WorkspaceId,
      callId: Schema.String,
      path: Schema.String,
      text: Schema.String,
    },
    success: WriteReceipt,
    error: DesktopError,
  }),

  /**
   * Lands bytes the page fetched from the server inside the chat's workspace,
   * under a collision-free name, or at `path` inside the chat's roots, which
   * the page has had the person approve like any write. A model operation, so
   * it carries a callId and is retained like a write: replaying it must not
   * land the file twice.
   */
  Rpc.make("saveToWorkspace", {
    payload: {
      conversationId: WorkspaceId,
      callId: Schema.String,
      fileName: Schema.String,
      base64: Schema.String,
      path: Schema.optionalKey(Schema.String),
    },
    success: WriteReceipt,
    error: DesktopError,
  }),

  /**
   * The raw bytes of a file. `view` is an image or PDF for a model or a person
   * to look at; `import` also takes a PowerPoint, for server tools to use for
   * the rest of the answer.
   */
  Rpc.make("readBinary", {
    payload: {
      conversationId: WorkspaceId,
      path: Schema.String,
      callId: Schema.String,
      purpose: Schema.Literals(["view", "import"]),
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
      conversationId: WorkspaceId,
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
      conversationId: WorkspaceId,
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
      conversationId: WorkspaceId,
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
      conversationId: WorkspaceId,
      pattern: Schema.String,
      callId: Schema.String,
    },
    success: FoundPaths,
    error: DesktopError,
  }),

  /** Lines matching a regular expression, `.gitignore` respected. */
  Rpc.make("searchFiles", {
    payload: {
      conversationId: WorkspaceId,
      callId: Schema.String,
      pattern: Schema.String,
      /** Narrows to paths matching this glob; absent searches everything. */
      glob: Schema.optionalKey(Schema.String),
    },
    success: SearchMatches,
    error: DesktopError,
  }),

  /**
   * Records network access the person approved for commands: one exact
   * host and port, for the answer that asked, the chat, or every chat.
   */
  Rpc.make("requestNetworkAccess", {
    payload: {
      conversationId: WorkspaceId,
      callId: Schema.String,
      /** The answer asking; an `answer` grant ends with it. */
      generationId: Schema.String,
      host: Schema.String,
      port: NetworkPort,
      privateNetwork: Schema.Boolean,
      scope: GrantScope,
    },
    success: NetworkPermission,
    error: DesktopError,
  }),

  /**
   * Records read access the person approved for commands: one exact path
   * outside the attached folders, for the answer that asked, the chat, or
   * every chat. The desktop resolves it and refuses what it would never grant.
   */
  Rpc.make("requestPathAccess", {
    payload: {
      conversationId: WorkspaceId,
      callId: Schema.String,
      generationId: Schema.String,
      path: Schema.String,
      scope: GrantScope,
    },
    success: Schema.Struct({ path: Schema.String, scope: GrantScope }),
    error: DesktopError,
  }),

  /**
   * Records a switch the person granted commands: local network services, for
   * the answer, the chat or every chat, or signing in with their SSH agent, for
   * the chat only.
   */
  Rpc.make("requestCapability", {
    payload: {
      conversationId: WorkspaceId,
      callId: Schema.String,
      generationId: Schema.String,
      capability: Capability,
      scope: GrantScope,
    },
    success: Schema.Struct({ scope: GrantScope }),
    error: DesktopError,
  }),

  /** The network destinations and paths a chat's commands may reach beyond the defaults. */
  Rpc.make("chatPermissions", {
    payload: { conversationId: WorkspaceId },
    success: ChatPermissions,
    error: DesktopError,
  }),

  /** Removes one of the chat's own grants; a removed network grant closes its tunnels. */
  Rpc.make("revokeChatPermission", {
    payload: { conversationId: WorkspaceId, permission: ChatPermission },
    success: Schema.Void,
    error: DesktopError,
  }),

  Rpc.make("runCommand", {
    payload: {
      conversationId: WorkspaceId,
      /** Correlates the sandbox violation record with the tool call. */
      callId: Schema.String,
      /** The answer running it, whose `answer` grants apply. */
      generationId: Schema.String,
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
      conversationId: WorkspaceId,
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

  /** Stages pasted bytes outside every model-visible workspace. */
  Rpc.make("stageFile", {
    payload: {
      conversationId: WorkspaceId,
      submissionId: LocalTransactionId,
      fileName: Schema.String,
      base64: Schema.String,
    },
    success: StagedFileReceipt,
    error: DesktopError,
  }),

  Rpc.make("discardStagedFile", {
    payload: {
      conversationId: WorkspaceId,
      submissionId: LocalTransactionId,
      name: Schema.String,
    },
    success: Schema.Void,
    error: DesktopError,
  }),

  Rpc.make("discardSubmission", {
    payload: { conversationId: WorkspaceId, submissionId: LocalTransactionId },
    success: Schema.Void,
    error: DesktopError,
  }),

  /** Atomically links one complete staged submission into the live workspace. */
  Rpc.make("promoteSubmission", {
    payload: {
      conversationId: WorkspaceId,
      submissionId: LocalTransactionId,
      reservationId: LocalTransactionId,
    },
    success: PromotionReceipt,
    error: DesktopError,
  }),

  Rpc.make("commitPromotion", {
    payload: { conversationId: WorkspaceId, reservationId: LocalTransactionId },
    success: Schema.Void,
    error: DesktopError,
  }),

  Rpc.make("rollbackPromotion", {
    payload: { conversationId: WorkspaceId, reservationId: LocalTransactionId },
    success: Schema.Void,
    error: DesktopError,
  }),

  Rpc.make("listPendingPromotions", {
    success: Schema.Array(PendingPromotion),
    error: DesktopError,
  }),

  /**
   * Copies the workspace of one conversation onto another: how a branch keeps
   * its local files. Refuses a non-empty destination rather than merging into
   * whatever the destination's lazy creation already holds.
   */
  Rpc.make("cloneWorkspace", {
    payload: { fromConversationId: WorkspaceId, toConversationId: WorkspaceId },
    success: Schema.Void,
    error: DesktopError,
  }),

  /** Copies the source conversation's local folder grants onto a branch. */
  Rpc.make("copyFolderGrants", {
    payload: { fromConversationId: WorkspaceId, toConversationId: WorkspaceId },
    success: FolderStatus,
    error: DesktopError,
  }),

  /**
   * Removes a conversation's workspace directory. Best-effort from the
   * delete-conversation action; nothing on the server waits for it.
   */
  Rpc.make("discardWorkspace", {
    payload: { conversationId: WorkspaceId },
    success: Schema.Void,
    error: DesktopError,
  }),
);

export type DesktopRpcs = typeof DesktopRpcs;
