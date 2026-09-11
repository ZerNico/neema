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
    "List the entries of a folder on the user's computer. Paths are relative to the attached " +
    'folder; use "." for its root. You cannot reach anything outside it.',
  parameters: Schema.Struct({ path: Path }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const readLocalFileTool = Tool.make("read_local_file", {
  description:
    "Read a text file on the user's computer, relative to the attached folder. Long files come " +
    "back truncated; say so if you rely on a truncated read.",
  parameters: Schema.Struct({ path: Path }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const writeLocalFileTool = Tool.make("write_local_file", {
  description:
    "Create or replace a text file on the user's computer, relative to the attached folder. " +
    "This writes the whole file, so include its complete contents; read it first unless you are " +
    "creating it. The user is asked before it happens and may refuse.",
  parameters: Schema.Struct({ path: Path, text: Schema.String }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const runCommandTool = Tool.make("run_command", {
  description:
    "Run a shell command in the attached folder on the user's computer. It runs sandboxed: it " +
    "may write only inside that folder and reach only package registries. The user is asked " +
    "before it happens and may refuse. Prefer reading files over running commands to inspect them.",
  parameters: Schema.Struct({
    command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000)),
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

  return {
    toolkit: deps.commands
      ? Toolkit.make(listFolderTool, readLocalFileTool, writeLocalFileTool, runCommandTool)
      : Toolkit.make(listFolderTool, readLocalFileTool, writeLocalFileTool),
    handlers: {
      list_folder: handle("list_folder", DESKTOP_TIMEOUTS.quick),
      read_local_file: handle("read_local_file", DESKTOP_TIMEOUTS.quick),
      // Writes and commands wait on a person as well as a machine.
      write_local_file: handle("write_local_file", DESKTOP_TIMEOUTS.command),
      ...(deps.commands ? { run_command: handle("run_command", DESKTOP_TIMEOUTS.command) } : {}),
    },
  };
};

export { changesTheMachine };
