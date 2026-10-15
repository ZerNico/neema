import type { NetworkScope } from "./work-controller.ts";
import { Effect } from "effect";
import { DesktopError, type DesktopClient } from "@chat/desktop-rpc";
import type { ToolActivity } from "~/modules/chat/client/use-message-stream.ts";
import { formatFileSize } from "~/modules/attachments/constants.ts";
import { attachmentUrl } from "~/modules/attachments/client/use-attachment-uploads.ts";
import type { BrowserToolName } from "~/modules/browser/tool-schema.ts";
import {
  DesktopToolResult,
  desktopFailure,
  DESKTOP_TIMEOUTS,
  deletePathsOf,
  lineArg,
  stringArg,
  type DesktopToolName,
} from "../tool-schema.ts";

type FileText = Effect.Success<ReturnType<DesktopClient["readFile"]>>;

/** Names the lines when the read was not the whole file. */
const readSummary = (file: FileText) => {
  const first = file.startLine ?? 1;
  const last = (file.nextLine ?? (file.lineCount ?? first) + 1) - 1;
  return first === 1 && !file.truncated
    ? `Read ${file.path}`
    : `Read ${file.path}, lines ${first}–${Math.max(first, last)}`;
};

/** The text, and where to go on from, so a long file is read in parts rather than not at all. */
const readDetail = (file: FileText) => {
  if (file.text === "" && file.lineCount !== undefined && (file.startLine ?? 1) > file.lineCount)
    return `(${file.path} has ${file.lineCount} lines, none from line ${file.startLine} on.)`;
  return file.nextLine
    ? `${file.text}\n[More follows: read on with offset ${file.nextLine}.]`
    : file.text;
};

const asResult = (
  outcome:
    | { readonly _tag: "Success"; readonly success: DesktopToolResult }
    | { readonly _tag: "Failure"; readonly failure: DesktopError },
): DesktopToolResult =>
  outcome._tag === "Success"
    ? outcome.success
    : desktopFailure(refusalSummary(outcome.failure.reason), outcome.failure.message);

/**
 * What the egress proxy refused, from the desktop's violation lines: destinations a grant would
 * open, those that need it to opt into private-network addresses, and refusals no grant changes.
 */
const networkRefusals = (violations: readonly string[]) => {
  const grant = new Set<string>();
  const privateNetwork = new Set<string>();
  const refused = new Set<string>();
  let agent: "refused" | "missing" | null = null;
  for (const violation of violations) {
    const denied = /^deny network-outbound (\S+):(\d{1,5})( private-network)?$/.exec(
      violation.trim(),
    );
    const port = Number(denied?.[2]);
    if (denied && port >= 1 && port <= 65_535)
      (denied[3] ? privateNetwork : grant).add(`${denied[1]}:${port}`);
    const other = /^refused network-outbound (\S+): (.+)$/.exec(violation.trim());
    // The SSH agent is a switch of its own, reached through a reserved destination.
    // The chat may have allowed it with no agent running, which no request would change.
    if (other?.[1] === "ssh-agent.invalid:1")
      agent = /no ssh agent was running/i.test(other[2] ?? "") ? "missing" : "refused";
    else if (other) refused.add(`${other[1]} (${other[2]})`);
  }
  return { grant: [...grant], privateNetwork: [...privateNetwork], refused: [...refused], agent };
};

/** Reader-facing line for the transcript row. The detail carries the rest. */
const refusalSummary = (reason: string) => {
  switch (reason) {
    case "no-folder":
      return "No folder is attached";
    case "outside-folder":
      return "That path is outside the folder";
    case "not-found":
      return "That file does not exist";
    case "not-text":
      return "That is not a text file";
    case "not-binary":
      return "That is not an image or a PDF";
    case "no-match":
      return "The text to replace was not found";
    case "ambiguous-match":
      return "The text to replace appears more than once";
    case "already-exists":
      return "That path already exists";
    case "bad-pattern":
      return "That pattern could not be read";
    case "sandbox-unavailable":
      return "Commands are unavailable";
    case "timed-out":
      return "That took too long";
    case "denied-by-user":
      return "You declined that";
    case "not-available":
      return "That file is not in this chat";
    default:
      return "That did not run";
  }
};

/**
 * One line per entry, the way `ls -F` and a size column would show it: a
 * folder ends in `/`, a symlink in `@`, a file carries its size. A bare name
 * with no extension is otherwise a guess the model has to spend a call on.
 */
const describeEntry = (entry: {
  readonly name: string;
  readonly kind: "file" | "directory" | "symlink" | "other";
  readonly size?: number;
}) => {
  switch (entry.kind) {
    case "directory":
      return `${entry.name}/`;
    case "symlink":
      return `${entry.name}@`;
    case "file":
      return entry.size === undefined
        ? entry.name
        : `${entry.name}  (${entry.size === 0 ? "empty" : formatFileSize(entry.size)})`;
    default:
      return entry.name;
  }
};

/** The name the server sent in Content-Disposition, or the id when it sent none. */
const fileNameOf = (response: Response, fallback: string) => {
  const header = response.headers.get("content-disposition") ?? "";
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8) {
    try {
      return decodeURIComponent(utf8[1]!);
    } catch {
      /* the plain name below */
    }
  }
  const plain = /filename="([^"]*)"/i.exec(header);
  return plain?.[1] || fallback;
};

/**
 * The page fetches under its own session, so the shell never holds a
 * credential and the server's access rule decides what may be copied.
 */
const fetchAttachment = (attachmentId: string) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(attachmentUrl(attachmentId), { credentials: "same-origin" });
      if (!response.ok) throw new Error(String(response.status));
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      for (let index = 0; index < bytes.length; index += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      return { name: fileNameOf(response, attachmentId), base64: btoa(binary) };
    },
    catch: (cause) =>
      new DesktopError({
        reason: "not-available",
        message:
          cause instanceof Error && cause.message === "404"
            ? "That attachment is not in this chat, or you cannot read it."
            : "The file could not be fetched from the server.",
      }),
  });

export const executeDesktopTool = (
  client: DesktopClient,
  conversationId: string,
  /** What is left of the server's deadline for this call when execution starts. */
  remainingMs: number,
  // The page runs browser calls in its own tabs (`modules/browser/client`).
  activity: Pick<Extract<ToolActivity, { family: "desktop" }>, "args" | "callId"> & {
    readonly name: Exclude<DesktopToolName, BrowserToolName>;
    /** The answer making the call; network grants for "this answer" belong to it. */
    readonly generationId: string;
    /** How long an approved network request lasts. */
    readonly scope: NetworkScope;
  },
): Effect.Effect<DesktopToolResult> => {
  const args = activity.args ?? {};
  const path = stringArg(args.path);
  const text = stringArg(args.text);
  const command = stringArg(args.command);
  const pattern = stringArg(args.pattern);

  const call = (): Effect.Effect<DesktopToolResult, DesktopError> => {
    switch (activity.name) {
      case "find_files":
        return Effect.map(
          client.findFiles({ callId: activity.callId, conversationId, pattern }),
          (found) => ({
            v: 1 as const,
            ok: true,
            summary: `Found ${found.paths.length} ${found.paths.length === 1 ? "match" : "matches"} for ${found.pattern}`,
            detail: found.paths.length === 0 ? "(no matches)" : found.paths.join("\n"),
            truncated: found.truncated,
          }),
        );
      case "search_files":
        return Effect.map(
          client.searchFiles({
            callId: activity.callId,
            conversationId,
            pattern,
            ...(stringArg(args.glob) ? { glob: stringArg(args.glob) } : {}),
          }),
          (hits) => ({
            v: 1 as const,
            ok: true,
            summary: `${hits.matches.length} ${hits.matches.length === 1 ? "match" : "matches"} for ${hits.pattern} in ${hits.filesSearched} files`,
            detail:
              hits.matches.length === 0
                ? "(no matches)"
                : hits.matches.map((hit) => `${hit.path}:${hit.line}: ${hit.text}`).join("\n"),
            truncated: hits.truncated,
          }),
        );
      case "edit_local_file":
        return Effect.map(
          client.editFile({
            callId: activity.callId,
            conversationId,
            path,
            old: stringArg(args.old),
            new: stringArg(args.new),
            all: args.all === true,
          }),
          (receipt) => ({
            v: 1 as const,
            ok: true,
            summary: `Edited ${receipt.path}${receipt.replacements > 1 ? ` (${receipt.replacements} places)` : ""}`,
            detail: receipt.diff,
            truncated: receipt.truncated,
          }),
        );
      case "move_local_file":
        return Effect.map(
          client.movePath({
            callId: activity.callId,
            conversationId,
            from: stringArg(args.from),
            to: stringArg(args.to),
          }),
          (receipt) => ({
            v: 1 as const,
            ok: true,
            summary: `Moved ${receipt.from} to ${receipt.to}`,
            detail: `${receipt.from} is now ${receipt.to}.`,
            truncated: false,
          }),
        );
      case "delete_local_file": {
        const paths = deletePathsOf(args);
        if (paths.length === 0) {
          return Effect.succeed(desktopFailure("Nothing to delete", "No paths were named."));
        }
        return Effect.map(
          client.deletePath({ callId: activity.callId, conversationId, paths }),
          (receipt) => {
            const lines = [
              ...receipt.deleted.map(
                (item) => `${item.kind === "directory" ? "Folder" : "File"} ${item.path} deleted.`,
              ),
              ...receipt.failed.map((item) => `${item.path}: ${item.message}`),
            ];
            const n = receipt.deleted.length;
            const missed = receipt.failed.length;
            const done = n === 1 ? `Deleted ${receipt.deleted[0]!.path}` : `Deleted ${n} files`;
            return {
              v: 1 as const,
              ok: n > 0,
              summary:
                n === 0
                  ? "Could not delete"
                  : missed === 0
                    ? done
                    : `${done} (${missed} could not)`,
              detail: lines.join("\n"),
              truncated: false,
            };
          },
        );
      }
      case "list_folder":
        return Effect.map(
          client.listDirectory({ callId: activity.callId, conversationId, path }),
          (listing) => ({
            v: 1 as const,
            ok: true,
            summary: `Listed ${listing.path}`,
            detail:
              listing.entries.length === 0
                ? "(empty)"
                : listing.entries.map(describeEntry).join("\n"),
            truncated: listing.truncated,
          }),
        );
      case "read_local_file": {
        const offset = lineArg(args.offset);
        const limit = lineArg(args.limit);
        return Effect.map(
          client.readFile({
            callId: activity.callId,
            conversationId,
            path,
            ...(offset ? { offset } : {}),
            ...(limit ? { limit } : {}),
          }),
          (file) => ({
            v: 1 as const,
            ok: true,
            summary: readSummary(file),
            detail: readDetail(file),
            truncated: file.truncated,
          }),
        ).pipe(
          // Not text is not a failure yet: an image or a PDF goes to the model
          // as bytes, and the server decides what this model can do with it.
          Effect.catchIf(
            (error) => error.reason === "not-text",
            () =>
              Effect.map(
                client.readBinary({
                  callId: activity.callId,
                  conversationId,
                  path,
                  purpose: "view",
                }),
                (file) => ({
                  v: 1 as const,
                  ok: true,
                  summary: `Read ${file.path}`,
                  detail: `${file.mediaType}, ${file.bytes} bytes`,
                  truncated: false,
                  file: { mediaType: file.mediaType, base64: file.base64, name: file.path },
                }),
              ),
          ),
        );
      }
      case "import_local_file":
        // Bytes for the server's tools, not for the model to look at; the loop
        // turns them into a working file and answers with its reference.
        return Effect.map(
          client.readBinary({ callId: activity.callId, conversationId, path, purpose: "import" }),
          (file) => ({
            v: 1 as const,
            ok: true,
            summary: `Imported ${file.path}`,
            detail: `${file.mediaType}, ${formatFileSize(file.bytes)}`,
            truncated: false,
            file: { mediaType: file.mediaType, base64: file.base64, name: file.path },
          }),
        );
      case "write_local_file":
        return Effect.map(
          client.writeFile({ callId: activity.callId, conversationId, path, text }),
          (receipt) => ({
            v: 1 as const,
            ok: true,
            summary: `${receipt.created ? "Created" : "Updated"} ${receipt.path}`,
            detail: `${receipt.bytes} bytes written.`,
            truncated: false,
          }),
        );
      case "save_to_workspace": {
        const attachmentId = stringArg(args.attachmentId);
        if (!attachmentId)
          return Effect.succeed(desktopFailure("Nothing to save", "No attachment id was named."));
        return Effect.flatMap(fetchAttachment(attachmentId), (file) =>
          Effect.map(
            client.saveToWorkspace({
              callId: activity.callId,
              conversationId,
              fileName: file.name,
              base64: file.base64,
              ...(path ? { path } : {}),
            }),
            (receipt) => ({
              v: 1 as const,
              ok: true,
              summary: `Saved ${receipt.path}`,
              detail: `${receipt.path}\n${formatFileSize(receipt.bytes)} written.`,
              truncated: false,
            }),
          ),
        );
      }
      case "request_network_access": {
        const host = stringArg(args.host);
        const port = args.port ?? 443;
        if (!host) return Effect.succeed(desktopFailure("No destination named", "Name a host."));
        if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535)
          return Effect.succeed(
            desktopFailure("Invalid port", "Name a port from 1 to 65535, or omit it for 443."),
          );
        return Effect.map(
          client.requestNetworkAccess({
            callId: activity.callId,
            conversationId,
            generationId: activity.generationId,
            host,
            port,
            privateNetwork: args.privateNetwork === true,
            scope: activity.scope,
          }),
          (receipt) => {
            const destination = `${receipt.host}:${receipt.port}`;
            const lasting =
              receipt.scope === "always"
                ? "for every chat"
                : receipt.scope === "chat"
                  ? "for this chat"
                  : "for this answer";
            return {
              v: 1 as const,
              ok: true,
              summary: `Allowed ${destination} ${lasting}`,
              detail: `The user allowed ${destination} ${lasting}. You may now run or retry the command.`,
              truncated: false,
            };
          },
        );
      }
      case "request_ssh_agent":
        return Effect.map(
          client.requestCapability({
            callId: activity.callId,
            conversationId,
            generationId: activity.generationId,
            capability: "ssh-agent",
            scope: "chat",
          }),
          () => ({
            v: 1 as const,
            ok: true,
            summary: "Allowed signing in with SSH keys for this chat",
            detail:
              "Commands in this chat may now sign in with the user's SSH agent. You may now retry the command.",
            truncated: false,
          }),
        );
      case "request_local_services":
        return Effect.map(
          client.requestCapability({
            callId: activity.callId,
            conversationId,
            generationId: activity.generationId,
            capability: "local-services",
            scope: activity.scope,
          }),
          (receipt) => {
            const lasting =
              receipt.scope === "always"
                ? "for every chat"
                : receipt.scope === "chat"
                  ? "for this chat"
                  : "for this answer";
            return {
              v: 1 as const,
              ok: true,
              summary: `Allowed services on this computer ${lasting}`,
              detail: `Commands may now use services on this computer ${lasting}. You may now run or retry the command.`,
              truncated: false,
            };
          },
        );
      case "request_path_access": {
        if (!path) return Effect.succeed(desktopFailure("No path named", "Name an absolute path."));
        return Effect.map(
          client.requestPathAccess({
            callId: activity.callId,
            conversationId,
            generationId: activity.generationId,
            path,
            scope: activity.scope,
          }),
          (receipt) => {
            const lasting =
              receipt.scope === "always"
                ? "for every chat"
                : receipt.scope === "chat"
                  ? "for this chat"
                  : "for this answer";
            return {
              v: 1 as const,
              ok: true,
              summary: `Allowed reading ${receipt.path} ${lasting}`,
              detail: `Commands may now read ${receipt.path} ${lasting}. You may now run or retry the command.`,
              truncated: false,
            };
          },
        );
      }
      case "run_command": {
        // A slow approval has already eaten into the server's wait; what is
        // left, minus the trip back, is all the command may take.
        const timeoutMs = Math.min(
          DESKTOP_TIMEOUTS.command,
          remainingMs - DESKTOP_TIMEOUTS.deliveryMargin,
        );
        if (timeoutMs <= 0) {
          return Effect.succeed(
            desktopFailure(
              "Not started",
              "Approval came too late for the command to finish in time. Ask again to run it.",
            ),
          );
        }
        return Effect.map(
          client.runCommand({
            callId: activity.callId,
            conversationId,
            generationId: activity.generationId,
            command,
            timeoutMs,
          }),
          (output) => {
            const network = networkRefusals(output.violations);
            const blocked = [...network.grant, ...network.privateNetwork];
            const refused =
              blocked.length > 0 || network.refused.length > 0 || network.agent !== null;
            return {
              v: 1 as const,
              ok: output.exitCode === 0 && !refused,
              summary: refused
                ? `Network access blocked: ${[...blocked, ...network.refused, ...(network.agent ? ["the SSH agent"] : [])].join(", ")}`
                : output.exitCode === 0
                  ? `Ran ${command}`
                  : `${command} exited with ${output.exitCode}`,
              detail: [
                ...(network.grant.length > 0
                  ? [
                      `Network access to ${network.grant.join(", ")} was blocked. Call request_network_access for each with its host and port, wait for approval, then retry the command. Do not assume the command succeeded.`,
                    ]
                  : []),
                ...(network.privateNetwork.length > 0
                  ? [
                      `Network access to ${network.privateNetwork.join(", ")} was blocked, and only a private network grant opens it (a private IP address, an internal name, or a host that resolved to a private address). Call request_network_access for each with privateNetwork true, wait for approval, then retry the command. Do not assume the command succeeded.`,
                    ]
                  : []),
                ...(network.agent === "refused"
                  ? [
                      "The command was refused the SSH agent. If it needs to sign in as the person, call request_ssh_agent, wait for approval, then retry the command.",
                    ]
                  : network.agent === "missing"
                    ? [
                        "This chat may use the SSH agent, but none was running on the person's computer. Ask them to start one (on macOS and Linux they may also name its socket in Settings › This computer), then retry the command.",
                      ]
                    : []),
                ...(network.refused.length > 0
                  ? [
                      `Network access was refused, and no request changes that: ${network.refused.join(", ")}. Do not assume the command succeeded.`,
                    ]
                  : []),
                output.output === "" ? "(no output)" : output.output,
              ].join("\n\n"),
              truncated: output.truncated,
              ...(output.violations.length > 0 ? { violations: output.violations } : {}),
            };
          },
        );
      }
    }
  };

  return Effect.map(Effect.result(call()), asResult);
};

export { DesktopToolResult };
