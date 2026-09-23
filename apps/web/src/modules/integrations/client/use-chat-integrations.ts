import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toastError } from "~/ui/error-toast.ts";
import { findIntegration } from "../catalog.ts";
import { setConversationIntegration } from "../server/functions.ts";
import { chatIntegrationsQuery, myIntegrationsQuery } from "./queries.ts";

export interface ComposerIntegration {
  integrationId: string;
  name: string;
  accountLabel: string;
  enabled: boolean;
}

export interface ComposerIntegrations {
  items: ReadonlyArray<ComposerIntegration>;
  /** Something is set up that this person could connect: worth offering "Add". */
  canAdd: boolean;
  setEnabled: (integrationId: string, enabled: boolean) => void;
  /** What a first message carries: toggles made before the chat existed. */
  sendFields: {
    integrationChoices?: ReadonlyArray<{ integrationId: string; enabled: boolean }>;
  };
}

/**
 * A chat's integration toggles. An existing chat saves each change at once,
 * since the choice belongs to the chat rather than to one message; a chat not
 * created yet holds them here until its first message carries them.
 */
export function useChatIntegrations(conversationId: string | null): ComposerIntegrations {
  const queryClient = useQueryClient();
  const query = useQuery(chatIntegrationsQuery(conversationId));
  const mine = useQuery(myIntegrationsQuery);
  const [local, setLocal] = useState<ReadonlyMap<string, boolean>>(new Map());
  const save = useMutation({
    mutationFn: (input: { integrationId: string; enabled: boolean }) =>
      setConversationIntegration({ data: { conversationId: conversationId!, ...input } }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: chatIntegrationsQuery(conversationId).queryKey }),
    onError: (error) => toastError("Could not change that integration for this chat.", error),
  });

  const items = (query.data ?? []).map((entry) => {
    const pendingSave =
      save.isPending && save.variables?.integrationId === entry.integrationId
        ? save.variables.enabled
        : undefined;
    return {
      integrationId: entry.integrationId,
      name: findIntegration(entry.integrationId)?.name ?? entry.integrationId,
      accountLabel: entry.accountLabel,
      enabled: pendingSave ?? local.get(entry.integrationId) ?? entry.enabled,
    };
  });
  const choices = conversationId
    ? []
    : [...local].map(([integrationId, enabled]) => ({ integrationId, enabled }));

  return {
    items,
    canAdd: (mine.data ?? []).some((integration) => integration.available),
    setEnabled: (integrationId, enabled) => {
      if (conversationId) save.mutate({ integrationId, enabled });
      else setLocal((current) => new Map(current).set(integrationId, enabled));
    },
    sendFields: choices.length ? { integrationChoices: choices } : {},
  };
}
