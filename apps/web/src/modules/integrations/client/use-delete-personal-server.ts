import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useConfirm } from "~/ui/confirm-context.ts";
import { toastError } from "~/ui/error-toast.ts";
import type { PersonalServer } from "../schema.ts";
import { deletePersonalServer } from "../server/functions.ts";
import { myIntegrationsQuery, personalServersQuery } from "./queries.ts";

/** Deletes one's own server after asking, then leaves its page. */
export function useDeletePersonalServer() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const remove = useMutation({
    mutationFn: (target: PersonalServer) =>
      deletePersonalServer({ data: { integrationId: target.id } }),
    onSuccess: async (result) => {
      if (!result.ok) {
        toastError("Could not delete the server.", new Error(result.error));
        return;
      }
      await navigate({ to: "/settings/integrations" });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: personalServersQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: myIntegrationsQuery.queryKey }),
      ]);
    },
    onError: (error) => toastError("Could not delete the server.", error),
  });
  const request = async (target: PersonalServer) => {
    if (
      await confirm({
        title: `Delete “${target.name}”?`,
        description: "Chats, agents and schedules stop using it. Past answers keep what it found.",
        confirmLabel: "Delete server",
      })
    )
      remove.mutate(target);
  };
  return { request, pending: remove.isPending };
}
