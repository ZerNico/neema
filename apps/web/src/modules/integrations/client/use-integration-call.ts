import { m } from "~/paraglide/messages.js";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toastError } from "~/ui/error-toast.ts";
import type { IntegrationDecision } from "../schema.ts";
import { decideIntegrationCall } from "../server/functions.ts";
import { approvalAction } from "../tool-text.ts";
import { useIntegrationDirectory } from "./directory.ts";
import { pendingIntegrationCallsQuery } from "./queries.ts";

/** Settles one waiting call, then refetches the list so every view drops it. */
export function useDecideIntegrationCall() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ callId, decision }: { callId: string; decision: IntegrationDecision }) =>
      decideIntegrationCall({ data: { callId, decision } }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: pendingIntegrationCallsQuery.queryKey }),
    onError: (error) => toastError(m.integrations_answer_send_error(), error),
  });
}

/** What a waiting call is to the person: the service's name and what it asks to do. */
export function useIntegrationCallNames(call: {
  integrationId: string;
  tool: string;
  label: string;
}) {
  const directory = useIntegrationDirectory();
  return {
    name: directory.name(call.integrationId),
    action: approvalAction(directory.find(call.integrationId)?.kind, call),
  };
}
