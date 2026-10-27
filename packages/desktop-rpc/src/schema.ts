import { Schema } from "effect";

/**
 * Shapes shared by the desktop process and the site running inside it. Both
 * sides decode against these, so neither trusts the other's word about a
 * payload: the site is remote code to the desktop, and the desktop is an
 * unprivileged peer to the site.
 */

/** A workspace is one server conversation and therefore one canonical UUIDv7. */
export const WorkspaceId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, {
    message: "Expected a canonical UUIDv7.",
  }),
);
export type WorkspaceId = typeof WorkspaceId.Type;

/**
 * The name every chat's own workspace answers to, at `/workspace` in its computer. The picker
 * refuses it for a user folder, so no attached folder's name collides with it.
 */
export const WORKSPACE_FOLDER_NAME = "workspace";

/** Caps live here so a bounded result is the contract, not each caller's habit. */
export const LIMITS = {
  /** One read. Beyond this the file comes back truncated with a marker. */
  readChars: 64_000,
  /**
   * Bytes pulled into memory for a text read or search. Enough UTF-8 for
   * `readChars`; the rest of a huge file is never buffered.
   */
  readBytes: 256_000,
  /** Combined stdout and stderr kept from one command. */
  outputChars: 32_000,
  /** Entries returned for one directory listing. */
  entries: 1_000,
  /** Bytes accepted in a single write. */
  writeBytes: 2_000_000,
  /** Paths returned by one find. Sorted by modification time, newest first. */
  foundPaths: 100,
  /** Matching lines returned by one search, across all files. */
  matches: 200,
  /** Characters kept of one matching line. */
  matchChars: 400,
  /** Paths accepted in one delete. A cleanup is one call, not one per file. */
  deletedPaths: 100,
  /**
   * Bytes of one binary file read or written whole: an image or document for
   * the model, an import, an attachment saved to disk. The web app's
   * attachment limit is this number, so either side can carry the other's file.
   */
  binaryBytes: 20 * 1024 * 1024,
  /**
   * Decoded bytes of one file that travels as base64 over IPC: a browser download or a file saved
   * to the workspace. At this cap one transiently costs ~67 MB of text plus structured-clone
   * copies in both processes.
   */
  importBytes: 50 * 1024 * 1024,
  /**
   * Workspace size above which a branch refuses to copy it: the copy is
   * awaited before navigation, so a multi-minute clone cannot pin the UI.
   * The branch opens with an empty workspace instead, and says so.
   */
  cloneBytes: 2 * 1024 * 1024 * 1024,
  /** Directory entries inspected before a branch copy refuses the workspace. */
  cloneEntries: 100_000,
  /** Nesting inspected independently of the entry cap. */
  cloneDepth: 256,
} as const;

export const FileContents = Schema.Struct({
  path: Schema.String,
  text: Schema.String,
  /** True when more of the file follows what was read. */
  truncated: Schema.Boolean,
  /** The first line read, counting from 1. */
  startLine: Schema.optionalKey(Schema.Int),
  /** Where the next read continues, when more follows. */
  nextLine: Schema.optionalKey(Schema.Int),
  /** The file's lines in all, known once a read reached its end. */
  lineCount: Schema.optionalKey(Schema.Int),
});
export type FileContents = typeof FileContents.Type;

/** Size and kind without the bytes: previews size the dialog before reading. */
export const FileInfo = Schema.Struct({
  path: Schema.String,
  bytes: Schema.Int,
});
export type FileInfo = typeof FileInfo.Type;

export const WriteReceipt = Schema.Struct({
  path: Schema.String,
  created: Schema.Boolean,
  bytes: Schema.Int,
});
export type WriteReceipt = typeof WriteReceipt.Type;

/**
 * A file the model reads as bytes rather than text: an image for a vision
 * model, a PDF for one that accepts documents or for the server's parser.
 * Base64 because the site's transport is JSON and the server's is too.
 */
export const BinaryContents = Schema.Struct({
  path: Schema.String,
  mediaType: Schema.String,
  base64: Schema.String,
  bytes: Schema.Int,
});
export type BinaryContents = typeof BinaryContents.Type;

/**
 * Why the desktop refused. Every case is something the reader can act on, so
 * none of them leak a host path the caller did not already name.
 */
export class DesktopError extends Schema.TaggedError<DesktopError>()("DesktopError", {
  reason: Schema.Literals([
    /** No folder by that name is attached to this conversation on this machine. */
    "no-folder",
    /** The path lies outside the workspace and the attached folders, or a link led out of them. */
    "outside-folder",
    /** The folder was attached read-only. */
    "read-only",
    "not-found",
    "not-a-file",
    /** The file is not text, so reading it as text would only produce noise. */
    "not-text",
    /** The file is neither an image nor a PDF. */
    "not-binary",
    /** Handing the file to its default application would run it. */
    "not-openable",
    /** A folder with that name is already attached. */
    "already-exists",
    "too-large",
    "failed",
  ]),
  message: Schema.String,
}) {}

/**
 * Extensions whose default application displays the file: documents, pictures,
 * sound and video. `openPath` picks that application by extension, and what
 * would run a file instead (`.terminal`, `.webloc`, `.py` on Windows) differs per
 * machine and keeps growing, so anything not named here is only shown in its
 * folder. Markup stays out: a browser runs an `.svg`'s or `.html`'s script from `file:`.
 *
 * Shared, so the site offers Open only where the desktop would. The desktop
 * still decides: a file marked executable is refused whatever it is called,
 * and the site cannot see that bit.
 */
export const OPENABLE_EXTENSIONS = new Set([
  // Documents
  ".pdf",
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".log",
  ".yaml",
  ".yml",
  ".rtf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".pages",
  ".numbers",
  ".key",
  // Pictures
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".heic",
  ".heif",
  ".avif",
  ".bmp",
  ".tif",
  ".tiff",
  // Sound and video
  ".mp3",
  ".m4a",
  ".wav",
  ".flac",
  ".aac",
  ".ogg",
  ".mp4",
  ".m4v",
  ".mov",
  ".webm",
]);

/**
 * What a reader asked the operating system to do with a file they can already
 * see named in the transcript: show it where it lives, or hand it to whatever
 * application owns that extension.
 */
export const RevealMode = Schema.Literals(["reveal", "open"]);
export type RevealMode = typeof RevealMode.Type;

/**
 * One attached folder as the site sees it: by name and guest path, never where it lives on this
 * machine, since host paths reach neither the server nor the model.
 */
export const AttachedFolder = Schema.Struct({
  /** The folder's basename, unique in the chat. */
  name: Schema.String,
  /** Where the chat's computer sees it: `/folders/<name>`. */
  path: Schema.String,
  /** False when the remembered folder has been moved, renamed or deleted since. */
  alive: Schema.Boolean,
  /** The computer may read it but not change it. */
  readOnly: Schema.Boolean,
});
export type AttachedFolder = typeof AttachedFolder.Type;

/** What the composer strip renders. An empty list is an invitation, not a fault. */
export const FolderStatus = Schema.Struct({
  folders: Schema.Array(AttachedFolder),
  /** The app-managed workspace, separate from user-picked folders. */
  workspace: Schema.Struct({
    /** Its guest path, `/workspace`. */
    path: Schema.String,
  }),
});
export type FolderStatus = typeof FolderStatus.Type;

const computerSettings = {
  /** Whether calls started on the person's other devices may run here. */
  remote: Schema.Boolean,
  /** The SSH agent socket chosen in Settings; null uses `SSH_AUTH_SOCK` or Windows' own. */
  agentSocket: Schema.NullOr(Schema.String),
};

/** Whether this machine can run chats' computers, with its own settings for them. */
export const ComputerStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ready"), ...computerSettings }),
  Schema.Struct({
    status: Schema.Literal("preparing"),
    /** From 0 to 1: the image download. */
    progress: Schema.Number,
    ...computerSettings,
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.String,
    ...computerSettings,
  }),
]);
export type ComputerStatus = typeof ComputerStatus.Type;
