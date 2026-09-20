import { LIMITS } from "@chat/desktop-rpc";
import { Duration, Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import type { ToolGroup } from "~/modules/tools/server/toolset.ts";
import { ExternalCompletion } from "~/modules/tools/server/external-completion.ts";
import { DESKTOP_TIMEOUTS, DesktopToolResult, desktopFailure } from "../tool-schema.ts";

/**
 * Tools that run on the user's machine instead of the server.
 *
 * The handler does not do the work: it waits for the loop's registration, then
 * blocks on `ExternalCompletion` until the page reports back. That keeps the whole
 * agentic loop where it already is. `streaming.ts` sees an ordinary
 * `tool-call` and an ordinary `tool-result`, folds them into the transcript
 * with `Prompt.fromResponseParts` like any other pair, and never learns that
 * the work happened somewhere else.
 */

const Path = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));

export const listFolderTool = Tool.make("list_folder", {
  description:
    'List a directory on the user\'s computer by its absolute path. "." lists the roots this chat ' +
    "can reach, each with its absolute path. You cannot reach anything outside them.",
  parameters: Schema.Struct({ path: Path }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const readLocalFileTool = Tool.make("read_local_file", {
  description:
    "Read a file on the user's computer by its absolute path. Text comes back as " +
    "text, truncated when long; an image or PDF comes back for you to look at when you can take " +
    "it, otherwise as extracted text or a note that you cannot.",
  parameters: Schema.Struct({ path: Path }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const findFilesTool = Tool.make("find_files", {
  description:
    "Find files and folders across the attached folders by glob, newest first: `*.ts` at any depth, " +
    "`src/**/*.test.ts`, `{a,b}.md`. Results come back as absolute paths. A folder whose name " +
    "matches is included, and so is every file inside it, so `*extracted*` finds " +
    "`DVR/extracted_images/` and its contents. Skips what .gitignore skips. Capped, so narrow " +
    "the pattern if the result says it was truncated.",
  parameters: Schema.Struct({
    pattern: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const searchFilesTool = Tool.make("search_files", {
  description:
    "Search file contents across the attached folders with a regular expression. Returns matching " +
    "lines with their absolute path and line number; skips binary files and what .gitignore " +
    "skips. Pass a glob to narrow which files are searched.",
  parameters: Schema.Struct({
    pattern: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
    glob: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const editLocalFileTool = Tool.make("edit_local_file", {
  description:
    "Replace text inside a file on the user's computer, by its absolute path. `old` must match " +
    "exactly, whitespace included, and exactly once unless `all` is true; include enough " +
    "surrounding lines to make it unique. Returns a diff of what changed. The user is asked " +
    "before it happens and may refuse.",
  parameters: Schema.Struct({
    path: Path,
    old: Schema.String.check(Schema.isMinLength(1)),
    new: Schema.String,
    all: Schema.optionalKey(Schema.Boolean),
  }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const moveLocalFileTool = Tool.make("move_local_file", {
  description:
    "Rename or move a file or folder by absolute paths, anywhere inside the attached folders. " +
    "Never overwrites an existing path. The user is asked before it happens and may refuse.",
  parameters: Schema.Struct({ from: Path, to: Path }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const deleteLocalFileTool = Tool.make("delete_local_file", {
  description:
    "Delete files or folders by absolute path, and everything inside a folder, within the " +
    `attached folders. Pass every path in one call rather than one call per file, up to ` +
    `${LIMITS.deletedPaths}. ` +
    "The user is asked once for that list and may refuse. This cannot be undone.",
  parameters: Schema.Struct({
    paths: Schema.Array(Path).check(Schema.isMinLength(1), Schema.isMaxLength(LIMITS.deletedPaths)),
  }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const writeLocalFileTool = Tool.make("write_local_file", {
  description:
    "Create or replace a text file on the user's computer by its absolute path. " +
    "This writes the whole file, so include its complete contents; read it first unless you are " +
    "creating it. The user is asked before it happens and may refuse.",
  parameters: Schema.Struct({ path: Path, text: Schema.String }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const runCommandTool = Tool.make("run_command", {
  description:
    "Run a shell command on the user's computer. The command starts in this chat's workspace, " +
    "and paths inside it are absolute: it may `cd` and `cp` anywhere inside the workspace and " +
    "the attached folders. It runs sandboxed: writes land only inside those roots and only " +
    "package registries are reachable. The user is asked before it happens and may refuse. " +
    "Prefer the file tools over commands to inspect or change files.",
  parameters: Schema.Struct({
    command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000)),
  }),
  success: DesktopToolResult,
  failureMode: "return",
});

export interface DesktopToolDeps {
  /** Waits for the durable row and its owned external registration to exist. */
  readonly rowIdFor: (providerCallId: string) => Effect.Effect<string | undefined>;
  /**
   * Whether the machine could sandbox a command when the message was sent.
   * False withholds `run_command` alone: the folder still attaches and reads
   * and writes still work, so a missing shell prerequisite never costs the
   * whole feature.
   */
  readonly commands: boolean;
}

const timedOut = (name: string) =>
  desktopFailure(
    "The computer did not answer",
    name === "run_command"
      ? "The command did not finish in time, or the desktop app is not reachable. Do not assume it ran."
      : "The desktop app did not answer in time. It may be closed. Ask the user rather than guessing.",
  );

/**
 * Offered only when the page said a folder is attached. Withholding them
 * otherwise is what keeps the model from proposing work it cannot do; a browser
 * tab with no desktop behind it never sees these names.
 */
export const prepareDesktopTools = (deps: DesktopToolDeps): ToolGroup => {
  const handle =
    (name: string, timeoutMs: number) =>
    (_params: Record<string, unknown>, ctx: { toolCallId: string }) =>
      Effect.gen(function* () {
        const external = yield* ExternalCompletion;
        // The SDK may start us while the observer is still inserting the row.
        // This wait is interrupted with the model stream on Stop or failure.
        const callId = yield* deps.rowIdFor(ctx.toolCallId);
        if (!callId) {
          return desktopFailure(
            "That could not be sent to the computer",
            "The request could not be matched to this conversation.",
          );
        }
        return yield* external.await(callId, {
          requireOpen: true,
          timeout: Duration.millis(timeoutMs),
          onTimeout: () => timedOut(name),
        });
      });

  const files = [
    listFolderTool,
    findFilesTool,
    searchFilesTool,
    readLocalFileTool,
    writeLocalFileTool,
    editLocalFileTool,
    moveLocalFileTool,
    deleteLocalFileTool,
  ] as const;
  return {
    toolkit: deps.commands ? Toolkit.make(...files, runCommandTool) : Toolkit.make(...files),
    handlers: {
      list_folder: handle("list_folder", DESKTOP_TIMEOUTS.quick),
      find_files: handle("find_files", DESKTOP_TIMEOUTS.quick),
      search_files: handle("search_files", DESKTOP_TIMEOUTS.quick),
      read_local_file: handle("read_local_file", DESKTOP_TIMEOUTS.quick),
      // Changes wait on a person as well as a machine.
      write_local_file: handle("write_local_file", DESKTOP_TIMEOUTS.command),
      edit_local_file: handle("edit_local_file", DESKTOP_TIMEOUTS.command),
      move_local_file: handle("move_local_file", DESKTOP_TIMEOUTS.command),
      delete_local_file: handle("delete_local_file", DESKTOP_TIMEOUTS.command),
      ...(deps.commands ? { run_command: handle("run_command", DESKTOP_TIMEOUTS.command) } : {}),
    },
  };
};
