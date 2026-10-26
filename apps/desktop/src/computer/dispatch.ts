import { posix } from "node:path";
import type { ToolResult } from "@chat/desktop-rpc";
import { LIMITS } from "@chat/desktop-rpc";
import type { EgressPolicy } from "./egress.ts";
import { runCommand } from "./exec.ts";
import {
  deletePaths,
  editTextFile,
  findFiles,
  listFolder,
  movePath,
  readBinaryFile,
  readTextFile,
  Refusal,
  saveBytes,
  searchFiles,
  writeTextFile,
} from "./files.ts";
import type { Guest } from "./hypervisor.ts";
import { place, WORKSPACE, type Mount } from "./paths.ts";
import { AGENT_VSOCK_PORT, type ChatKey, type ChatSetup, type ChatVms } from "./vms.ts";

/** A call as the machine received it, its deadline already on this machine's clock. */
export interface ComputerCall {
  readonly callId: string;
  readonly key: ChatKey;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** Milliseconds left until the server stops waiting for the answer. */
  readonly remainingMs: number;
  readonly attachments?: ReadonlyArray<{ id: string; path: string }>;
  readonly signal: AbortSignal;
}

export interface DispatchDeps {
  readonly vms: ChatVms;
  readonly egress: EgressPolicy;
  /** The chat's workspace and attached folders on this machine. */
  readonly setup: (key: ChatKey) => Promise<ChatSetup>;
  /** Downloads one of the chat's attachments with the machine's own session. */
  readonly attachment: (
    key: ChatKey,
    id: string,
  ) => Promise<{ name: string; bytes: Buffer } | null>;
  /** Whether the chat may use the person's SSH agent; read when a command starts. */
  readonly agentAllowed: (key: ChatKey) => boolean;
  /**
   * Asks the person at this machine, in a native dialog, for a folder: exactly `path` when the
   * model named one, else through the folder picker. Resolves to the folder's name in the chat,
   * or a sentence saying why there is none.
   */
  readonly requestFolder: (
    key: ChatKey,
    input: { path?: string; reason?: string },
  ) => Promise<{ name: string } | { refused: string }>;
  /** Asks the person at this machine whether the chat may use their SSH agent. */
  readonly requestAgent: (key: ChatKey) => Promise<boolean>;
}

/** Where `ssh-agent-bridge` in the image presents the person's agent inside the guest. */
export const AGENT_SOCKET = "/run/ssh-agent.sock";

/** How much of the server's wait a command leaves for its output to travel back. */
const DELIVERY_MARGIN_MS = 15_000;
const COMMAND_MS = 600_000;

const str = (value: unknown) => (typeof value === "string" ? value : "");
const line = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;

const ok = (summary: string, detail: string, truncated = false): ToolResult => ({
  v: 1,
  ok: true,
  summary,
  detail,
  truncated,
});
const failure = (summary: string, detail: string): ToolResult => ({
  v: 1,
  ok: false,
  summary,
  detail,
  truncated: false,
});

const REFUSAL_SUMMARY: Record<Refusal["reason"], string> = {
  outside: "That path is outside this chat's folders",
  "not-found": "That file does not exist",
  "not-a-directory": "That is not a folder",
  "not-text": "That is not a text file",
  "not-binary": "That is not an image or a PDF",
  "too-large": "That file is too large",
  "no-match": "The text to replace was not found",
  "ambiguous-match": "The text to replace appears more than once",
  "already-exists": "That path already exists",
  "bad-pattern": "That pattern could not be read",
  "read-only": "That folder is read-only",
  failed: "That did not work",
};

const sizeOf = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * Copies the chat's attachments into the guest where the server said they live, once each:
 * a file already at its path stays, so an edit the model made is never put back.
 */
const copyAttachments = async (
  deps: DispatchDeps,
  call: ComputerCall,
  guest: Guest,
  mounts: readonly Mount[],
) => {
  for (const attachment of call.attachments ?? []) {
    const placed = place(attachment.path, mounts);
    if (!placed.ok || placed.readOnly || (await guest.stat(placed.path))) continue;
    const file = await deps.attachment(call.key, attachment.id).catch(() => null);
    if (!file) continue;
    await guest.run({ argv: ["/bin/mkdir", "-p", posix.dirname(placed.path)] });
    await guest.write(placed.path, file.bytes).catch(() => {});
  }
};

/** Runs one call in the chat's VM and words the answer the model reads. */
export async function dispatch(deps: DispatchDeps, call: ComputerCall): Promise<ToolResult> {
  // Asking the person needs no VM.
  if (call.name === "request_folder") {
    const answer = await deps.requestFolder(call.key, {
      ...(str(call.args.path) ? { path: str(call.args.path) } : {}),
      ...(str(call.args.reason) ? { reason: str(call.args.reason) } : {}),
    });
    return "refused" in answer
      ? failure("No folder was given", answer.refused)
      : ok(
          `Attached /folders/${answer.name}`,
          `The user gave this chat the folder at /folders/${answer.name}. The tools reach it from the next call on.`,
        );
  }
  if (call.name === "request_ssh_agent")
    return (await deps.requestAgent(call.key))
      ? ok(
          "Allowed the SSH agent in this chat",
          "Commands in this chat may now sign in with the user's SSH agent. Retry the command.",
        )
      : failure("You declined that", "The user declined. Do not retry it or work around it.");
  const setup = await deps.setup(call.key);
  const { mounts } = setup;
  const args = call.args;
  try {
    return await deps.vms.use(
      call.key,
      setup,
      async (guest) => {
        await copyAttachments(deps, call, guest, mounts);
        return await run(deps, call, guest, mounts, args);
      },
      call.signal,
    );
  } catch (error) {
    if (error instanceof Refusal) return failure(REFUSAL_SUMMARY[error.reason], error.message);
    if (call.signal.aborted) return failure("Stopped", "The call was stopped before it finished.");
    return failure(
      "The computer could not do that",
      `It failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1_000),
    );
  }
}

async function run(
  deps: DispatchDeps,
  call: ComputerCall,
  guest: Guest,
  mounts: readonly Mount[],
  args: Readonly<Record<string, unknown>>,
): Promise<ToolResult> {
  switch (call.name) {
    case "list_folder": {
      const listing = await listFolder(guest, mounts, str(args.path));
      return ok(
        `Listed ${listing.path}`,
        listing.entries.length === 0
          ? "(empty)"
          : listing.entries
              .map((entry) =>
                entry.kind === "directory"
                  ? `${entry.name}/`
                  : entry.kind === "symlink"
                    ? `${entry.name}@`
                    : "size" in entry && typeof entry.size === "number"
                      ? `${entry.name}  (${entry.size === 0 ? "empty" : sizeOf(entry.size)})`
                      : entry.name,
              )
              .join("\n"),
        listing.truncated,
      );
    }
    case "read_local_file": {
      const path = str(args.path);
      const extension = posix.extname(path).toLowerCase();
      if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf"].includes(extension)) {
        const file = await readBinaryFile(guest, mounts, path, "view");
        return {
          ...ok(`Read ${file.path}`, `${file.mediaType}, ${sizeOf(file.bytes.length)}`),
          file: {
            mediaType: file.mediaType,
            base64: file.bytes.toString("base64"),
            name: file.path,
          },
        };
      }
      const file = await readTextFile(guest, mounts, path, line(args.offset), line(args.limit));
      const first = file.startLine;
      const last = (file.nextLine ?? (file.lineCount ?? first) + 1) - 1;
      const summary =
        first === 1 && !file.truncated
          ? `Read ${file.path}`
          : `Read ${file.path}, lines ${first}–${Math.max(first, last)}`;
      const detail =
        file.text === "" && file.lineCount !== undefined && first > file.lineCount
          ? `(${file.path} has ${file.lineCount} lines, none from line ${first} on.)`
          : file.nextLine
            ? `${file.text}\n[More follows: read on with offset ${file.nextLine}.]`
            : file.text;
      return ok(summary, detail, file.truncated);
    }
    case "import_local_file": {
      const file = await readBinaryFile(guest, mounts, str(args.path), "import");
      return {
        ...ok(`Imported ${file.path}`, `${file.mediaType}, ${sizeOf(file.bytes.length)}`),
        file: { mediaType: file.mediaType, base64: file.bytes.toString("base64"), name: file.path },
      };
    }
    case "find_files": {
      const found = await findFiles(guest, mounts, str(args.pattern));
      return ok(
        `Found ${found.paths.length} ${found.paths.length === 1 ? "match" : "matches"} for ${found.pattern}`,
        found.paths.length === 0 ? "(no matches)" : found.paths.join("\n"),
        found.truncated,
      );
    }
    case "search_files": {
      const glob = str(args.glob) || undefined;
      const hits = await searchFiles(guest, mounts, str(args.pattern), glob);
      return ok(
        `${hits.matches.length} ${hits.matches.length === 1 ? "match" : "matches"} for ${hits.pattern} in ${hits.filesSearched} files`,
        hits.matches.length === 0
          ? "(no matches)"
          : hits.matches.map((hit) => `${hit.path}:${hit.line}: ${hit.text}`).join("\n"),
        hits.truncated,
      );
    }
    case "write_local_file": {
      const receipt = await writeTextFile(guest, mounts, str(args.path), str(args.text));
      return ok(
        `${receipt.created ? "Created" : "Updated"} ${receipt.path}`,
        `${receipt.bytes} bytes written.`,
      );
    }
    case "edit_local_file": {
      const receipt = await editTextFile(guest, mounts, {
        path: str(args.path),
        old: str(args.old),
        new: str(args.new),
        all: args.all === true,
      });
      return ok(
        `Edited ${receipt.path}${receipt.replacements > 1 ? ` (${receipt.replacements} places)` : ""}`,
        receipt.diff,
        receipt.truncated,
      );
    }
    case "move_local_file": {
      const receipt = await movePath(guest, mounts, str(args.from), str(args.to));
      return ok(`Moved ${receipt.from} to ${receipt.to}`, `${receipt.from} is now ${receipt.to}.`);
    }
    case "delete_local_file": {
      const paths = Array.isArray(args.paths)
        ? args.paths.filter((path) => typeof path === "string")
        : [];
      const receipt = await deletePaths(guest, mounts, paths.slice(0, LIMITS.deletedPaths));
      const n = receipt.deleted.length;
      const lines = [
        ...receipt.deleted.map(
          (item) => `${item.kind === "directory" ? "Folder" : "File"} ${item.path} deleted.`,
        ),
        ...receipt.failed.map((item) => `${item.path}: ${item.message}`),
      ];
      const done = n === 1 ? `Deleted ${receipt.deleted[0]!.path}` : `Deleted ${n} files`;
      return {
        ...ok(
          receipt.failed.length ? `${done} (${receipt.failed.length} could not)` : done,
          lines.join("\n"),
        ),
        ok: n > 0 || receipt.failed.length === 0,
      };
    }
    case "save_to_workspace": {
      const file = await deps.attachment(call.key, str(args.attachmentId));
      if (!file)
        return failure(
          "That file is not in this chat",
          "That attachment is not in this chat, or the user cannot read it.",
        );
      const path = str(args.path);
      const receipt = await saveBytes(
        guest,
        mounts,
        path ? { path } : { folder: WORKSPACE, name: file.name },
        file.bytes,
      );
      return ok(`Saved ${receipt.path}`, `${receipt.path}\n${sizeOf(receipt.bytes)} written.`);
    }
    case "run_command":
      return command(deps, call, guest, str(args.command));
    default:
      return failure("Unknown tool", `This computer does not know ${call.name}.`);
  }
}

async function command(deps: DispatchDeps, call: ComputerCall, guest: Guest, text: string) {
  const violations: string[] = [];
  // A slow approval has already eaten into the server's wait; what is left, minus the trip back,
  // is all the command may take.
  const timeoutMs = Math.min(COMMAND_MS, call.remainingMs - DELIVERY_MARGIN_MS);
  if (timeoutMs <= 0)
    return failure(
      "Not started",
      "Approval came too late for the command to finish in time. Ask again to run it.",
    );
  const agent = deps.agentAllowed(call.key);
  // The bridge runs outside any command's cgroup, so it outlives the command that started it.
  if (agent)
    await guest.run({
      argv: [
        "/bin/sh",
        "-c",
        `test -S ${AGENT_SOCKET} || (setsid ssh-agent-bridge ${AGENT_VSOCK_PORT} ${AGENT_SOCKET} >/dev/null 2>&1 &)`,
      ],
    });
  const refused = deps.egress.watch({ server: call.key.origin, chat: call.key.conversationId });
  const outcome = await runCommand(guest, {
    command: text,
    cwd: WORKSPACE,
    timeoutMs,
    signal: call.signal,
    outputLimit: LIMITS.outputChars,
    ...(agent ? { env: { SSH_AUTH_SOCK: AGENT_SOCKET } } : {}),
  }).finally(() => {
    violations.push(...refused());
  });
  const blocked = violations.length > 0;
  const head = outcome.timedOut
    ? `The command was still running after ${Math.round(timeoutMs / 1000)}s and was stopped.`
    : outcome.stopped
      ? "The command was stopped."
      : null;
  return {
    v: 1 as const,
    ok: outcome.exitCode === 0 && !blocked && !outcome.timedOut && !outcome.stopped,
    summary: blocked
      ? `Network access blocked: ${violations.map((entry) => entry.split(" ")[0]).join(", ")}`
      : outcome.timedOut
        ? `${text} timed out`
        : outcome.exitCode === 0
          ? `Ran ${text}`
          : `${text} exited with ${outcome.exitCode}`,
    detail: [
      ...(blocked
        ? [
            `Network access was refused: ${violations.join("; ")}. For a destination that needs a request, call request_network_access with its host and port, wait for approval, then retry. Do not assume the command succeeded.`,
          ]
        : []),
      ...(head ? [head] : []),
      outcome.output ? outcome.output : "(no output)",
      `Exit code ${outcome.exitCode}.`,
    ].join("\n"),
    truncated: outcome.truncated,
    ...(blocked ? { violations } : {}),
  };
}
