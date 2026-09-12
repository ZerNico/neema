import { createFileRoute, useLocation, useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { readChatPrefill } from "~/modules/agents/authoring.ts";
import { agentsQuery } from "~/modules/agents/client/queries.ts";
import { NewChatView } from "~/modules/chat/ui/chat-view.tsx";
import { DRAFT_CONVERSATION, prepareWorkFolder } from "~/modules/desktop/client/bridge.ts";
import {
  chatModelsQuery,
  researchAvailabilityQuery,
  webSearchAvailabilityQuery,
} from "~/modules/chat/client/queries.ts";

export const Route = createFileRoute("/_app/")({
  // `?agent=<id>` from an agent page pre-selects it in the composer. The
  // server still authorizes the install at send time.
  validateSearch: (search: Record<string, unknown>): { agent?: string; skill?: string } => ({
    ...(typeof search["agent"] === "string" && search["agent"].length <= 128
      ? { agent: search["agent"] }
      : {}),
    ...(typeof search["skill"] === "string" && search["skill"].length <= 128
      ? { skill: search["skill"] }
      : {}),
  }),
  loader: async ({ context, abortController }) => {
    await Promise.all([
      prepareWorkFolder(context.queryClient, DRAFT_CONVERSATION, abortController.signal),
      context.queryClient.ensureQueryData(chatModelsQuery),
      context.queryClient.prefetchQuery(agentsQuery),
      // Optional: a search-config failure must not prevent opening a chat.
      context.queryClient.prefetchQuery({ ...webSearchAvailabilityQuery, retry: false }),
      context.queryClient.prefetchQuery({ ...researchAvailabilityQuery, retry: false }),
    ]);
  },
  component: NewChatPage,
});

function NewChatPage() {
  // `user` comes from the parent `_app` route's beforeLoad context.
  const { user } = Route.useRouteContext();
  const { agent, skill } = Route.useSearch();
  const router = useRouter();
  const location = useLocation();
  // oxlint-disable eslint/no-underscore-dangle -- TanStack owns this history entry key.
  const consumePrefill = useCallback(() => {
    const current = router.history.location;
    if (current.state.__TSR_key !== location.state.__TSR_key || !("chatPrefill" in current.state))
      return;
    const { chatPrefill: _consumed, ...state } = current.state;
    // Replace this entry, not the view. Keep the router’s index and all unrelated state.
    router.history.replace(current.href, state);
  }, [location.state.__TSR_key, router]);
  // oxlint-enable eslint/no-underscore-dangle
  return (
    <NewChatView
      key={JSON.stringify([agent, skill])}
      user={user}
      initialAgentId={agent ?? null}
      initialSkillId={skill ?? null}
      initialPrefill={readChatPrefill(location.state.chatPrefill)}
      onPrefillConsumed={consumePrefill}
    />
  );
}
