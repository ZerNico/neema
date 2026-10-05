import { createContext, useContext, useMemo } from "react";
import { describeTarget } from "~/modules/browser/client/execute-browser.ts";
import type { ApprovalChoice, PendingKind } from "./approvals.ts";
import type { WorkController } from "./work-controller.ts";

export const WorkContext = createContext<{
  controller: WorkController | null;
  revision: number;
  paused: boolean;
}>({
  controller: null,
  revision: 0,
  paused: false,
});

/**
 * Stable until the controller reports a change: this feeds the message list's
 * display memo, so a fresh object per render would re-render every message on
 * every stream chunk.
 */
export function useWorkApprovals(conversationId: string) {
  const { controller, revision } = useContext(WorkContext);
  return useMemo(
    () => ({
      pending: controller?.pending(conversationId) ?? new Map<string, PendingKind>(),
      decide: (callId: string, choice: ApprovalChoice) => controller?.decide(callId, choice),
      args: (callId: string) => {
        const args = controller?.args(callId) ?? null;
        // A browser action names an element by reference; the card says what it is.
        const target = args && describeTarget(conversationId, args);
        return target && args ? { ...args, target } : args;
      },
      /** The controller's change counter, so this value is new exactly when its contents are. */
      revision,
    }),
    [controller, conversationId, revision],
  );
}
