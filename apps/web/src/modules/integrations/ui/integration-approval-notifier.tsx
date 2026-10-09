import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { pendingIntegrationCallsQuery } from "../client/queries.ts";
import { useIntegrationDirectory } from "../client/directory.ts";

/**
 * Announces a waiting integration call once when its chat is not on screen.
 * The card itself stays in the transcript; this is only the nudge to go there.
 * The list is fetched on `integration.approval.changed`, never polled.
 */
export function IntegrationApprovalNotifier() {
  const { data } = useQuery(pendingIntegrationCallsQuery);
  const navigate = useNavigate();
  const path = useRouterState({ select: (state) => state.location.pathname });
  const announced = useRef(new Map<string, string | number>());
  const { name } = useIntegrationDirectory();

  useEffect(() => {
    const waiting = new Set((data ?? []).map((call) => call.callId));
    for (const [callId, toastId] of announced.current) {
      if (waiting.has(callId)) continue;
      toast.dismiss(toastId);
      announced.current.delete(callId);
    }
    for (const call of data ?? []) {
      const here = path === `/chat/${call.conversationId}`;
      const shown = announced.current.get(call.callId);
      if (here) {
        if (shown !== undefined) toast.dismiss(shown);
        continue;
      }
      if (shown !== undefined) continue;
      const waitingFor = call.kind === "elicitation" ? "an answer" : "your approval";
      const id = toast(`${name(call.integrationId)} is waiting for ${waitingFor}.`, {
        duration: Infinity,
        action: {
          label: "Review",
          onClick: () =>
            void navigate({
              to: "/chat/$conversationId",
              params: { conversationId: call.conversationId },
            }),
        },
      });
      announced.current.set(call.callId, id);
    }
  }, [data, path, navigate, name]);

  return null;
}
