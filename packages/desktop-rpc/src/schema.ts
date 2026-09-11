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
    "too-large",
    /** Commands are unavailable because the sandbox is not ready. */
    "sandbox-unavailable",
    "timed-out",
    "denied-by-user",
    "failed",
  ]),
  message: Schema.String,
}) {}

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
 * What the site is told about the attached folder. The absolute path never
 * crosses: the site shows a name and the server stores nothing, so the same
 * conversation on another machine simply resolves to a different folder.
 */
export const FolderStatus = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["attached"]),
    name: Schema.String,
    sandbox: SandboxAvailability,
  }),
  Schema.Struct({ kind: Schema.Literals(["none"]) }),
  Schema.Struct({
    kind: Schema.Literals(["unresolved"]),
    /** Last known name, so the prompt to re-pick can say which folder is missing. */
    name: Schema.optionalKey(Schema.String),
  }),
]);
export type FolderStatus = typeof FolderStatus.Type;
