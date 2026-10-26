import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  computerSnapshot,
  decideComputerCall,
  listNetworkGrants,
  removeNetworkGrant,
  resetChatEnvironment,
  switchChatComputer,
} from "../server/functions.ts";

export const COMPUTER_QUERY_KEY = ["computer"] as const;

/** The person's machines and every computer call waiting for them; refreshed on `computer.changed`. */
export function useComputerSnapshot() {
  return useQuery({
    queryKey: [...COMPUTER_QUERY_KEY, "snapshot"],
    queryFn: () => computerSnapshot(),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export type ComputerChoice = Parameters<typeof decideComputerCall>[0]["data"]["choice"];

interface ComputerApproval {
  readonly approval: "bind" | "edit" | "command" | "delete" | "network";
  readonly machine: string | undefined;
  readonly reason: string | undefined;
  readonly args: Record<string, unknown>;
  readonly decide: (choice: ComputerChoice) => void;
}

/** One map for every chat without a waiting call, so rows keyed on it never rebuild. */
const NONE: ReadonlyMap<string, ComputerApproval> = new Map();

/** The waiting calls of one chat, by call id, each with a way to answer it. */
export function useComputerApprovals(conversationId: string) {
  const snapshot = useComputerSnapshot();
  const queryClient = useQueryClient();
  const decide = useMutation({
    mutationFn: (input: { callId: string; choice: ComputerChoice }) =>
      decideComputerCall({ data: input }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: COMPUTER_QUERY_KEY }),
  });
  // `mutate` is stable; the mutation object is a new one every render.
  const { mutate } = decide;
  return useMemo(() => {
    const waiting = (snapshot.data?.pending ?? []).filter(
      (call) => call.conversationId === conversationId,
    );
    if (waiting.length === 0) return NONE;
    return new Map<string, ComputerApproval>(
      waiting.map((call) => [
        call.callId,
        {
          approval: call.approval,
          machine: call.machine?.name,
          reason: call.reason,
          args: JSON.parse(call.args) as Record<string, unknown>,
          decide: (choice: ComputerChoice) => mutate({ callId: call.callId, choice }),
        },
      ]),
    );
  }, [snapshot.data, conversationId, mutate]);
}

export function useComputerActions(conversationId: string) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: COMPUTER_QUERY_KEY });
  return {
    switchTo: useMutation({
      mutationFn: (machineId: string | null) =>
        switchChatComputer({ data: { conversationId, machineId } }),
      onSettled: () =>
        Promise.all([
          refresh(),
          queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] }),
        ]),
    }),
    reset: useMutation({
      mutationFn: () => resetChatEnvironment({ data: { conversationId } }),
    }),
  };
}

export function useNetworkGrants() {
  const queryClient = useQueryClient();
  const grants = useQuery({
    queryKey: [...COMPUTER_QUERY_KEY, "grants"],
    queryFn: () => listNetworkGrants(),
  });
  const remove = useMutation({
    mutationFn: (grantId: string) => removeNetworkGrant({ data: { grantId } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: [...COMPUTER_QUERY_KEY, "grants"] }),
  });
  return { grants, remove };
}
