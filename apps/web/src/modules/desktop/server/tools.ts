import { LIMITS } from "@chat/desktop-rpc";
import { Duration, Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import type { ToolGroup } from "~/modules/tools/server/toolset.ts";
import { ExternalCompletion } from "~/modules/tools/server/external-completion.ts";
import { advertisedParameter } from "~/modules/tools/server/toolset.ts";
import {
  DesktopToolResult,
  desktopFailure,
  desktopToolTimeout,
  type DesktopToolName,
} from "../tool-schema.ts";

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

export const importLocalFileTool = Tool.make("import_local_file", {
  description:
    "Bring a PNG, JPEG, PowerPoint (.pptx), Excel workbook (.xlsx) or Word document (.docx) " +
    "from the user's computer into this answer so other tools can use it. Returns a working: " +
    "reference: pass a picture as imageRef, a deck as sourceRef to inspect_presentation and " +
    "edit_presentation, a workbook to inspect_spreadsheet and edit_spreadsheet, or a document " +
    "to inspect_word_file and edit_word_file. The copy lasts for this " +
    "answer only and the original is never changed. Up to 20 MB.",
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

export const saveToWorkspaceTool = Tool.make("save_to_workspace", {
  description:
    "Copy a file this chat already holds on the server onto the user's computer, by the " +
    "attachment id a tool result gave you. Without path it lands in the chat's workspace under " +
    "a new name if needed, so a command or another local tool can reach it. With path, an " +
    "absolute path inside the workspace or an attached folder, it is saved exactly there, " +
    "replacing a file of that name; the user is asked first, like any write. Use path to put a " +
    "finished file (a published deck, a created CSV) where the user wants it in one step.",
  parameters: Schema.Struct({
    attachmentId: Schema.String.check(Schema.isMinLength(1)),
    path: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const runCommandTool = Tool.make("run_command", {
  description:
    "Run a shell command on the user's computer. The command starts in this chat's workspace, " +
    "and paths inside it are absolute: it may `cd` and `cp` anywhere inside the workspace and " +
    "the attached folders. It runs sandboxed: writes land only inside those roots and only " +
    "package registries are reachable by default. A blocked destination needs a separate " +
    "request_network_access call naming its host and port, and user approval before retrying. " +
    "The user is asked before " +
    "the command happens and may refuse. Installed Python and Node can run here; discover " +
    "the executable when needed. Each call is a fresh process, so shell state does not persist. " +
    "Prefer the file tools over commands to inspect or change files.",
  parameters: Schema.Struct({
    command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000)),
  }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const requestNetworkAccessTool = Tool.make("request_network_access", {
  description:
    "Ask the user to let commands on their computer reach one network destination: an exact " +
    "host or public IP address and port, such as registry.example.com on 443 or github.com on " +
    "22 for git over SSH. " +
    "Request it before running a command that needs it, or use the destination a blocked " +
    "run_command result reports. Wait for approval before running or retrying the command. " +
    "The user decides whether it lasts for this answer, this chat, or every chat. Set " +
    "privateNetwork only for a host on their local or company network, such as an internal " +
    "git server or a private IP address. Proxied TCP only: plain HTTP and UDP never work.",
  // Every key decodes anything, absent included, so the handler explains a malformed call.
  parameters: Schema.Struct({
    host: advertisedParameter({ type: "string", minLength: 1, maxLength: 253 }),
    port: advertisedParameter({
      type: "integer",
      minimum: 1,
      maximum: 65_535,
      description: "Defaults to 443.",
    }),
    privateNetwork: advertisedParameter({ type: "boolean" }),
  }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const requestPathAccessTool = Tool.make("request_path_access", {
  description:
    "Ask the user to let commands read one exact file or folder outside the attached folders, " +
    "such as a reference repository or a document in Downloads. Use it when a command fails " +
    "with a permission error on a path outside the workspace and attached folders, or before " +
    "running a command that needs one. Name the absolute path. Wait for approval before " +
    "running or retrying the command. The user decides whether it lasts for this answer, this " +
    "chat, or every chat. Read only: to write somewhere, ask the user to attach that folder. " +
    "The home folder as a whole and credential files are never shared.",
  parameters: Schema.Struct({
    path: advertisedParameter({ type: "string", minLength: 1, maxLength: 4_096 }),
  }),
  success: DesktopToolResult,
  failureMode: "return",
});

export const requestLocalServicesTool = Tool.make("request_local_services", {
  description:
    "Ask the user to let commands use local network services on their computer: connect to " +
    "servers on localhost and accept connections. Build tools such as Gradle, test suites " +
    "that start a local server, and dev servers need it. Use it when a command fails with a " +
    "socket or connection error on localhost, such as Gradle not reaching its daemon or " +
    "'Operation not permitted' binding a port. Wait for approval before running or retrying " +
    "the command. The user decides whether it lasts for this answer, this chat, or every chat.",
  parameters: Tool.EmptyParams,
  success: DesktopToolResult,
  failureMode: "return",
});

export const requestSshAgentTool = Tool.make("request_ssh_agent", {
  description:
    "Ask the user to let commands in this chat sign in with their SSH keys through their SSH " +
    "agent, for example to push with git over SSH. Use it when an SSH connection to a host " +
    "this chat may reach fails with 'Permission denied (publickey)'. Request the host's port " +
    "with request_network_access first. The key files themselves are never readable. Wait for " +
    "approval before retrying. It lasts for this chat only.",
  parameters: Tool.EmptyParams,
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
/** A handler that only waits for the machine to answer the call it was given. */
export const awaitDesktopCall =
  (rowIdFor: DesktopToolDeps["rowIdFor"], name: string, timeoutMs: number) =>
  (_params: unknown, ctx: { toolCallId: string }) =>
    Effect.gen(function* () {
      const external = yield* ExternalCompletion;
      // The SDK may start us while the observer is still inserting the row.
      // This wait is interrupted with the model stream on Stop or failure.
      const callId = yield* rowIdFor(ctx.toolCallId);
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

export const prepareDesktopTools = (deps: DesktopToolDeps): ToolGroup => {
  const handle = (name: DesktopToolName) =>
    awaitDesktopCall(deps.rowIdFor, name, desktopToolTimeout(name));

  const files = [
    listFolderTool,
    findFilesTool,
    searchFilesTool,
    readLocalFileTool,
    importLocalFileTool,
    writeLocalFileTool,
    saveToWorkspaceTool,
    editLocalFileTool,
    moveLocalFileTool,
    deleteLocalFileTool,
  ] as const;
  return {
    toolkit: deps.commands
      ? Toolkit.make(
          ...files,
          runCommandTool,
          requestNetworkAccessTool,
          requestPathAccessTool,
          requestLocalServicesTool,
          requestSshAgentTool,
        )
      : Toolkit.make(...files),
    handlers: {
      list_folder: handle("list_folder"),
      find_files: handle("find_files"),
      search_files: handle("search_files"),
      read_local_file: handle("read_local_file"),
      import_local_file: handle("import_local_file"),
      write_local_file: handle("write_local_file"),
      save_to_workspace: handle("save_to_workspace"),
      edit_local_file: handle("edit_local_file"),
      move_local_file: handle("move_local_file"),
      delete_local_file: handle("delete_local_file"),
      ...(deps.commands
        ? {
            run_command: handle("run_command"),
            request_network_access: handle("request_network_access"),
            request_path_access: handle("request_path_access"),
            request_local_services: handle("request_local_services"),
            request_ssh_agent: handle("request_ssh_agent"),
          }
        : {}),
    },
  };
};
