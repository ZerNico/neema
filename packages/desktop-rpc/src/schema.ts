import { Schema } from "effect";

/**
 * Shapes shared by the desktop process and the site running inside it. Both
 * sides decode against these, so neither trusts the other's word about a
 * payload: the site is remote code to the desktop, and the desktop is an
 * unprivileged peer to the site.
 */

/** Caps live here so a bounded result is the contract, not each caller's habit. */
export const LIMITS = {
  /** One read. Beyond this the file comes back truncated with a marker. */
  readChars: 64_000,
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
  /** Bytes of one binary file (image or document) sent to the model. */
  binaryBytes: 20 * 1024 * 1024,
} as const;

export const DirectoryEntry = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["file", "directory", "symlink", "other"]),
  /** Absent for anything that is not a plain file. */
  size: Schema.optionalKey(Schema.Int),
});
export type DirectoryEntry = typeof DirectoryEntry.Type;

export const DirectoryListing = Schema.Struct({
  /** Relative to the folder root, `.` for the root itself. */
  path: Schema.String,
  entries: Schema.Array(DirectoryEntry),
  /** True when the directory held more than `LIMITS.entries`. */
  truncated: Schema.Boolean,
});
export type DirectoryListing = typeof DirectoryListing.Type;

export const FileContents = Schema.Struct({
  path: Schema.String,
  text: Schema.String,
  /** True when the file was longer than `LIMITS.readChars`. */
  truncated: Schema.Boolean,
});
export type FileContents = typeof FileContents.Type;

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
 * What an edit did. The diff is the model's proof that the change landed
 * where it meant it to; without it a wrong-but-unique match goes unnoticed
 * until something breaks.
 */
export const EditReceipt = Schema.Struct({
  path: Schema.String,
  replacements: Schema.Int,
  /** Unified diff of the change, capped like a read. */
  diff: Schema.String,
  truncated: Schema.Boolean,
});
export type EditReceipt = typeof EditReceipt.Type;

export const MoveReceipt = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
});
export type MoveReceipt = typeof MoveReceipt.Type;

export const DeleteReceipt = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literals(["file", "directory"]),
});
export type DeleteReceipt = typeof DeleteReceipt.Type;

export const FoundPaths = Schema.Struct({
  pattern: Schema.String,
  /** Relative to the folder root, newest first. */
  paths: Schema.Array(Schema.String),
  /** True when more than `LIMITS.foundPaths` matched. */
  truncated: Schema.Boolean,
});
export type FoundPaths = typeof FoundPaths.Type;

export const SearchMatch = Schema.Struct({
  path: Schema.String,
  line: Schema.Int,
  /** The matching line, capped at `LIMITS.matchChars`. */
  text: Schema.String,
});
export type SearchMatch = typeof SearchMatch.Type;

export const SearchMatches = Schema.Struct({
  pattern: Schema.String,
  matches: Schema.Array(SearchMatch),
  /** Files searched, so an empty result reads as "nothing found" not "nothing looked at". */
  filesSearched: Schema.Int,
  /** True when more than `LIMITS.matches` lines matched. */
  truncated: Schema.Boolean,
});
export type SearchMatches = typeof SearchMatches.Type;

export const CommandOutput = Schema.Struct({
  exitCode: Schema.Int,
  output: Schema.String,
  truncated: Schema.Boolean,
  /**
   * Sandbox denials, already turned into sentences. Empty on Linux, which has
   * no violation reporting, so an empty list never means "nothing was blocked".
   */
  violations: Schema.Array(Schema.String),
});
export type CommandOutput = typeof CommandOutput.Type;

/**
 * Why the desktop refused. Every case is something the model or the reader can
 * act on, so none of them leak a host path the caller did not already name.
 */
export class DesktopError extends Schema.TaggedError<DesktopError>()("DesktopError", {
  reason: Schema.Literals([
    /** No folder is attached to this conversation on this machine. */
    "no-folder",
    /** The path resolved outside the attached folder, or through a symlink that did. */
    "outside-folder",
    "not-found",
    "not-a-file",
    "not-a-directory",
    /** The file is not text, so reading it as text would only produce noise. */
    "not-text",
    /** The file is neither an image nor a document the model could take. */
    "not-binary",
    /** Handing the file to its default application would run it. */
    "not-openable",
    /** An edit's old text was not found, or was found more than once. */
    "no-match",
    "ambiguous-match",
    /** A move's destination already exists, or a folder with that name is already attached. */
    "already-exists",
    /** The pattern could not be compiled. */
    "bad-pattern",
    "too-large",
    /** Commands are unavailable because the sandbox is not ready. */
    "sandbox-unavailable",
    "timed-out",
    "denied-by-user",
    "failed",
  ]),
  message: Schema.String,
}) {}

/**
 * Extensions whose default application runs the file rather than displays it.
 * `openPath` chooses that application by extension, so opening one would run
 * what the model wrote. Markup is here for the same reason: an `.svg` or an
 * `.html` handed to a browser runs its script from `file:`.
 *
 * Shared, so the site can hide an action the desktop would refuse rather than
 * keep a second list that drifts from this one. The desktop still decides:
 * a file marked executable is refused whatever it is called, and the site
 * cannot see that bit.
 */
export const UNOPENABLE_EXTENSIONS = new Set([
  ".app",
  ".appimage",
  ".bat",
  ".bin",
  ".cmd",
  ".com",
  ".command",
  ".cpl",
  ".desktop",
  ".dll",
  ".exe",
  ".hta",
  ".htm",
  ".html",
  ".inf",
  ".jar",
  ".js",
  ".jse",
  ".lnk",
  ".msc",
  ".msi",
  ".pif",
  ".ps1",
  ".reg",
  ".run",
  ".scpt",
  ".scr",
  ".sh",
  ".so",
  ".svg",
  ".svgz",
  ".url",
  ".vb",
  ".vbe",
  ".vbs",
  ".workflow",
  ".wsf",
  ".wsh",
  ".xht",
  ".xhtml",
]);

/**
 * What a reader asked the operating system to do with a file they can already
 * see named in the transcript: show it where it lives, or hand it to whatever
 * application owns that extension.
 */
export const RevealMode = Schema.Literals(["reveal", "open"]);
export type RevealMode = typeof RevealMode.Type;

/**
 * How far a command may reach. Package managers are what a build needs and
 * the default. Policy of the chat, held by the server; the page passes it
 * down with each command, so the desktop never stores it.
 */
export const NetworkLevel = Schema.Literals(["none", "packages", "all"]);
export type NetworkLevel = typeof NetworkLevel.Type;

/** Whether commands can run, and if not, whether the app itself can fix it. */
export const SandboxAvailability = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["ready"]) }),
  Schema.Struct({
    kind: Schema.Literals(["setup-needed"]),
    /** Windows only today: an elevated one-time install the app can trigger. */
    platform: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literals(["missing-deps"]),
    missing: Schema.Array(Schema.String),
    hint: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literals(["unsupported"]), reason: Schema.String }),
]);
export type SandboxAvailability = typeof SandboxAvailability.Type;

/**
 * One attached folder as the site sees it. The absolute path never crosses:
 * the site shows a name and the server stores nothing, so the same
 * conversation on another machine simply resolves to different folders.
 *
 * The name is the folder's basename and doubles as the first segment of every
 * path the model uses (`site/src/index.ts`), which is why two folders with the
 * same name cannot both be attached.
 */
export const AttachedFolder = Schema.Struct({
  name: Schema.String,
  /** False when the remembered folder has been moved, renamed or deleted since. */
  alive: Schema.Boolean,
});
export type AttachedFolder = typeof AttachedFolder.Type;

/** What the composer strip renders. An empty list is an invitation, not a fault. */
export const FolderStatus = Schema.Struct({
  folders: Schema.Array(AttachedFolder),
  sandbox: SandboxAvailability,
});
export type FolderStatus = typeof FolderStatus.Type;
