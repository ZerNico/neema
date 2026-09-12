import { Effect } from "effect";
import { useEffect, useRef } from "react";
import type { DesktopClient, DesktopError, NetworkLevel } from "@chat/desktop-rpc";
import type { ToolActivity } from "~/modules/chat/client/use-message-stream.ts";
import { submitDesktopToolResult } from "../server/functions.ts";
import { DesktopToolResult, desktopFailure } from "../tool-schema.ts";
import { approvalKind, type DesktopApprovals } from "./approvals.ts";
import { useDesktop } from "./bridge.ts";

/**
 * Runs the model's local tool calls and reports back.
 *
 * The server cannot touch the machine, so it publishes the call on the message
 * stream the page is already subscribed to and blocks a handler until this
 * sends an answer. That keeps the whole agentic loop server-side: the page is
 * a courier, not a driver, and never resubmits a transcript.
 *
 * Each call is executed exactly once. The stream replays on reconnect and the
 * same activity is re-rendered on every chunk, so without that guard a
 * reconnect mid-command would run it again.
 *
 * Anything that changes the machine waits on the reader first. That gate is
 * here rather than on the server because this is what holds the call: a refusal
 * is enforced by the work never happening, not by a flag somebody must honour.
 */

const CONVERSATION_LIMIT = 1;

const asResult = (
  outcome:
    | { readonly _tag: "Success"; readonly success: DesktopToolResult }
    | { readonly _tag: "Failure"; readonly failure: DesktopError },
): DesktopToolResult =>
  outcome._tag === "Success"
    ? outcome.success
    : desktopFailure(refusalSummary(outcome.failure.reason), outcome.failure.message);

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
      return entry.size === undefined ? entry.name : `${entry.name}  (${formatSize(entry.size)})`;
    default:
      return entry.name;
  }
};

const formatSize = (bytes: number) =>
  bytes === 0
    ? "empty"
    : bytes < 1024
      ? `${bytes} B`
      : bytes < 1024 * 1024
        ? `${Math.round(bytes / 1024)} KB`
        : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const execute = (
  client: DesktopClient,
  conversationId: string,
  network: NetworkLevel,
  activity: Extract<ToolActivity, { family: "desktop" }>,
): Effect.Effect<DesktopToolResult> => {
  const args = activity.args ?? {};
  const str = (value: unknown) => (typeof value === "string" ? value : "");
  const path = str(args.path);
  const text = str(args.text);
  const command = str(args.command);
  const pattern = str(args.pattern);

  const call = (): Effect.Effect<DesktopToolResult, DesktopError> => {
    switch (activity.name) {
      case "find_files":
        return Effect.map(client.findFiles({ conversationId, pattern }), (found) => ({
          v: 1 as const,
          ok: true,
          summary: `Found ${found.paths.length} ${found.paths.length === 1 ? "file" : "files"} matching ${found.pattern}`,
          detail: found.paths.length === 0 ? "(no matches)" : found.paths.join("\n"),
          truncated: found.truncated,
        }));
      case "search_files":
        return Effect.map(
          client.searchFiles({
            conversationId,
            pattern,
            ...(str(args.glob) ? { glob: str(args.glob) } : {}),
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
            conversationId,
            path,
            old: str(args.old),
            new: str(args.new),
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
          client.movePath({ conversationId, from: str(args.from), to: str(args.to) }),
          (receipt) => ({
            v: 1 as const,
            ok: true,
            summary: `Moved ${receipt.from} to ${receipt.to}`,
            detail: `${receipt.from} is now ${receipt.to}.`,
            truncated: false,
          }),
        );
      case "delete_local_file":
        return Effect.map(client.deletePath({ conversationId, path }), (receipt) => ({
          v: 1 as const,
          ok: true,
          summary: `Deleted ${receipt.path}`,
          detail: `${receipt.kind === "directory" ? "Folder" : "File"} ${receipt.path} deleted.`,
          truncated: false,
        }));
      case "list_folder":
        return Effect.map(client.listDirectory({ conversationId, path }), (listing) => ({
          v: 1 as const,
          ok: true,
          summary: `Listed ${listing.path}`,
          detail:
            listing.entries.length === 0
              ? "(empty)"
              : listing.entries.map(describeEntry).join("\n"),
          truncated: listing.truncated,
        }));
      case "read_local_file":
        return Effect.map(client.readFile({ conversationId, path }), (file) => ({
          v: 1 as const,
          ok: true,
          summary: `Read ${file.path}`,
          detail: file.text,
          truncated: file.truncated,
        })).pipe(
          // Not text is not a failure yet: an image or a PDF goes to the model
          // as bytes, and the server decides what this model can do with it.
          Effect.catchIf(
            (error) => error.reason === "not-text",
            () =>
              Effect.map(client.readBinary({ conversationId, path }), (file) => ({
                v: 1 as const,
                ok: true,
                summary: `Read ${file.path}`,
                detail: `${file.mediaType}, ${file.bytes} bytes`,
                truncated: false,
                file: { mediaType: file.mediaType, base64: file.base64, name: file.path },
              })),
          ),
        );
      case "write_local_file":
        return Effect.map(client.writeFile({ conversationId, path, text }), (receipt) => ({
          v: 1 as const,
          ok: true,
          summary: `${receipt.created ? "Created" : "Updated"} ${receipt.path}`,
          detail: `${receipt.bytes} bytes written.`,
          truncated: false,
        }));
      case "run_command":
        return Effect.map(
          client.runCommand({
            conversationId,
            callId: activity.callId,
            command,
            folder: str(args.folder),
            timeoutMs: 300_000,
            network,
          }),
          (output) => ({
            v: 1 as const,
            ok: output.exitCode === 0,
            summary:
              output.exitCode === 0
                ? `Ran ${command}`
                : `${command} exited with ${output.exitCode}`,
            detail: output.output === "" ? "(no output)" : output.output,
            truncated: output.truncated,
            ...(output.violations.length > 0 ? { violations: output.violations } : {}),
          }),
        );
    }
  };

  return Effect.map(Effect.result(call()), asResult);
};

const DECLINED = desktopFailure(
  "You declined that",
  "The user declined this. Do not try it again in another form; ask what they would prefer.",
);

export const useDesktopTools = (
  conversationId: string,
  activities: ReadonlyArray<ToolActivity>,
  approvals: DesktopApprovals,
  network: NetworkLevel,
): void => {
  const client = useDesktop();
  const { ask } = approvals;
  // Read when the call runs, not when the effect was scheduled.
  const networkRef = useRef(network);
  useEffect(() => {
    networkRef.current = network;
  }, [network]);
  // Survives re-renders and stream replays; a call runs once per page load.
  const handled = useRef(new Set<string>());
  useEffect(() => {
    if (!client) return;
    const pending = activities.filter(
      (activity): activity is Extract<ToolActivity, { family: "desktop" }> =>
        activity.family === "desktop" &&
        activity.status === "running" &&
        !handled.current.has(activity.callId),
    );
    for (const activity of pending.slice(0, CONVERSATION_LIMIT)) {
      handled.current.add(activity.callId);
      const allowed = ask(activity.callId, approvalKind(activity.name));
      void allowed
        .then((permitted) =>
          Effect.runPromise(
            permitted
              ? Effect.flatMap(
                  execute(client, conversationId, networkRef.current, activity),
                  (result) =>
                    Effect.promise(() =>
                      submitDesktopToolResult({
                        data: { conversationId, callId: activity.callId, result },
                      }),
                    ),
                )
              : Effect.promise(() =>
                  submitDesktopToolResult({
                    data: { conversationId, callId: activity.callId, result: DECLINED },
                  }),
                ),
          ),
        )
        .catch(() => {
          // The generation may already have stopped or timed out, in which case
          // nobody is waiting and there is nothing to report to.
        });
    }
  }, [ask, client, conversationId, activities]);
};

export { DesktopToolResult };
