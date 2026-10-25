import { m } from "~/paraglide/messages.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toastError } from "~/ui/error-toast.ts";
import { setConversationIntegration } from "../server/functions.ts";
import { chatIntegrationsQuery, myIntegrationsQuery } from "./queries.ts";

/** One of the person's accounts, as the composer lists and toggles it. */
export interface ComposerIntegration {
  connectionId: string;
  integrationId: string;
  name: string;
  /** What the person calls the account; null when it uses none of theirs. */
  account: string | null;
  enabled: boolean;
}

export interface ComposerIntegrations {
  items: ReadonlyArray<ComposerIntegration>;
  /** Something is set up that this person could connect: worth offering "Add". */
  canAdd: boolean;
  setEnabled: (connectionId: string, enabled: boolean) => void;
  /** What a first message carries: toggles made before the chat existed. */
  sendFields: {
    integrationChoices?: ReadonlyArray<{ connectionId: string; enabled: boolean }>;
  };
}

/**
 * A chat's account toggles. An existing chat saves each change at once,
 * since the choice belongs to the chat rather than to one message; a chat not
 * created yet holds them here until its first message carries them.
 */
export function useChatIntegrations(conversationId: string | null): ComposerIntegrations {
  const queryClient = useQueryClient();
  const query = useQuery(chatIntegrationsQuery(conversationId));
  const mine = useQuery(myIntegrationsQuery);
  const [local, setLocal] = useState<ReadonlyMap<string, boolean>>(new Map());
  const save = useMutation({
    mutationFn: (input: { connectionId: string; enabled: boolean }) =>
      setConversationIntegration({ data: { conversationId: conversationId!, ...input } }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: chatIntegrationsQuery(conversationId).queryKey }),
    onError: (error) => toastError(m.integrations_chat_toggle_error(), error),
  });

  const items = (query.data ?? []).map((entry) => {
    const pendingSave =
      save.isPending && save.variables?.connectionId === entry.connectionId
        ? save.variables.enabled
        : undefined;
    return {
      connectionId: entry.connectionId,
      integrationId: entry.integrationId,
      name: entry.name,
      account: entry.account,
      enabled: pendingSave ?? local.get(entry.connectionId) ?? entry.enabled,
    };
  });
  const choices = conversationId
    ? []
    : [...local].map(([connectionId, enabled]) => ({ connectionId, enabled }));

  return {
    items,
    canAdd: (mine.data ?? []).some((integration) => integration.available),
    setEnabled: (connectionId, enabled) => {
      if (conversationId) save.mutate({ connectionId, enabled });
      else setLocal((current) => new Map(current).set(connectionId, enabled));
    },
    sendFields: choices.length ? { integrationChoices: choices } : {},
  };
}
