import { Duration, Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import type { ToolGroup } from "~/modules/tools/server/toolset.ts";
import { ExternalCompletion } from "~/modules/tools/server/external-completion.ts";
import {
  DESKTOP_TIMEOUTS,
  DesktopToolResult,
  changesTheMachine,
  desktopFailure,
} from "../tool-schema.ts";

/**
 * Tools that run on the user's machine instead of the server.
 *
 * The handler does not do the work: it publishes the call and blocks on
 * `ExternalCompletion` until the page reports back. That keeps the whole
 * agentic loop where it already is. `streaming.ts` sees an ordinary
 * `tool-call` and an ordinary `tool-result`, folds them into the transcript
 * with `Prompt.fromResponseParts` like any other pair, and never learns that
 * the work happened somewhere else.
 */

const Path = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));

export const listFolderTool = Tool.make("list_folder", {
  description:
    'List a folder on the user\'s computer. "." lists the attached folders; every other path ' +
    'starts with one of their names, like "site/src". You cannot reach anything outside them.',
  parameters: Schema.Struct({ path: Path }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const readLocalFileTool = Tool.make("read_local_file", {
  description:
    "Read a file on the user's computer, starting with an attached folder's name. Text comes back as " +
    "text, truncated when long; an image or PDF comes back for you to look at when you can take " +
    "it, otherwise as extracted text or a note that you cannot.",
  parameters: Schema.Struct({ path: Path }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const findFilesTool = Tool.make("find_files", {
  description:
    "Find files across the attached folders by glob, newest first: `*.ts` at any depth, " +
    "`src/**/*.test.ts`, `{a,b}.md`. Skips what .gitignore skips. Capped, so narrow the pattern " +
    "if the result says it was truncated.",
  parameters: Schema.Struct({
    pattern: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const searchFilesTool = Tool.make("search_files", {
  description:
    "Search file contents across the attached folders with a regular expression. Returns matching " +
    "lines with their file and line number; skips binary files and what .gitignore skips. Pass " +
    "a glob to narrow which files are searched.",
  parameters: Schema.Struct({
    pattern: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
    glob: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const editLocalFileTool = Tool.make("edit_local_file", {
  description:
    "Replace text inside a file on the user's computer. `old` must match exactly, whitespace " +
    "included, and exactly once unless `all` is true; include enough surrounding lines to make " +
    "it unique. Returns a diff of what changed. The user is asked before it happens and may refuse.",
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
    "Rename or move a file or folder within the attached folders. Never overwrites an existing " +
    "path. The user is asked before it happens and may refuse.",
  parameters: Schema.Struct({ from: Path, to: Path }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const deleteLocalFileTool = Tool.make("delete_local_file", {
  description:
    "Delete a file, or a folder and everything inside it, within the attached folders. This " +
    "cannot be undone. The user is always asked first and may refuse.",
  parameters: Schema.Struct({ path: Path }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const writeLocalFileTool = Tool.make("write_local_file", {
  description:
    "Create or replace a text file on the user's computer, starting with an attached folder's name. " +
    "This writes the whole file, so include its complete contents; read it first unless you are " +
    "creating it. The user is asked before it happens and may refuse.",
  parameters: Schema.Struct({ path: Path, text: Schema.String }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const runCommandTool = Tool.make("run_command", {
  description:
    "Run a shell command on the user's computer, inside one of the attached folders. It runs " +
    "sandboxed: it may write only inside the attached folders and reach only package " +
    "registries. The user is asked before it happens and may refuse. Prefer the file tools " +
    "over commands to inspect or change files.",
  parameters: Schema.Struct({
    command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000)),
    /** The attached folder to run in, by name. */
    folder: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  }),
  success: DesktopToolResult,
  failureMode: "return",
});

export interface DesktopToolDeps {
  /**
   * Resolves the durable row id for a provider call id.
   *
   * The page is told about the call by the loop's own `start` envelope, which
   * already carries the arguments and the real turn and call index. So a
   * handler does not announce anything: by the time it runs, the row exists and
   * the page has been asked. All it does is wait for the answer.
   */
  readonly rowIdFor: (providerCallId: string) => string | undefined;
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
        // The transcript row is created by the loop when it sees the call, so
        // the durable id exists by the time a handler runs.
        const callId = deps.rowIdFor(ctx.toolCallId);
        if (!callId) {
          return desktopFailure(
            "That could not be sent to the computer",
            "The request could not be matched to this conversation.",
          );
        }
        return yield* external.await(callId, {
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

export { changesTheMachine };
