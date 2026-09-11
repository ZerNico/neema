import { Effect } from "effect";
import { useEffect, useRef } from "react";
import type { DesktopClient, DesktopError } from "@chat/desktop-rpc";
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

const execute = (
  client: DesktopClient,
  conversationId: string,
  activity: Extract<ToolActivity, { family: "desktop" }>,
): Effect.Effect<DesktopToolResult> => {
  const args = activity.args ?? {};
  const path = typeof args.path === "string" ? args.path : "";
  const text = typeof args.text === "string" ? args.text : "";
  const command = typeof args.command === "string" ? args.command : "";

  const call = (): Effect.Effect<DesktopToolResult, DesktopError> => {
    switch (activity.name) {
      case "list_folder":
        return Effect.map(client.listDirectory({ conversationId, path }), (listing) => ({
          v: 1 as const,
          ok: true,
          summary: `Listed ${listing.path}`,
          detail:
            listing.entries.length === 0
              ? "(empty)"
              : listing.entries
                  .map((entry) => (entry.kind === "directory" ? `${entry.name}/` : entry.name))
                  .join("\n"),
          truncated: listing.truncated,
        }));
      case "read_local_file":
        return Effect.map(client.readFile({ conversationId, path }), (file) => ({
          v: 1 as const,
          ok: true,
          summary: `Read ${file.path}`,
          detail: file.text,
          truncated: file.truncated,
        }));
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
            timeoutMs: 300_000,
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
): void => {
  const client = useDesktop();
  const { ask } = approvals;
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
      const kind = approvalKind(activity.name);
      const allowed = kind ? ask(activity.callId, kind) : Promise.resolve(true);
      void allowed
        .then((permitted) =>
          Effect.runPromise(
            permitted
              ? Effect.flatMap(execute(client, conversationId, activity), (result) =>
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
