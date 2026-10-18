import { createFileRoute, useLocation, useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { readChatPrefill } from "~/modules/agents/authoring.ts";
import { agentsQuery } from "~/modules/agents/client/queries.ts";
import { NewChatView } from "~/modules/chat/ui/new-chat-view.tsx";
import {
  chatModelsQuery,
  researchAvailabilityQuery,
  webSearchAvailabilityQuery,
} from "~/modules/chat/client/queries.ts";
import { knowledgeCollectionsQuery } from "~/modules/knowledge/client/queries.ts";
import { skillsQuery } from "~/modules/skills/client/queries.ts";

export const Route = createFileRoute("/_app/")({
  // Sending leaves this page for the new chat, so nothing may be opened here.
  staticData: { detailPanel: false },
  // `?agent=<id>` from an agent page pre-selects it in the composer. The
  // server still authorizes the install at send time.
  validateSearch: (
    search: Record<string, unknown>,
  ): { agent?: string; skill?: string; temporary?: 1; project?: string } => ({
    ...(typeof search["agent"] === "string" && search["agent"].length <= 128
      ? { agent: search["agent"] }
      : {}),
    ...(typeof search["skill"] === "string" && search["skill"].length <= 128
      ? { skill: search["skill"] }
      : {}),
    // In the address so a reload keeps the choice.
    ...(search["temporary"] === 1 || search["temporary"] === "1" ? { temporary: 1 as const } : {}),
    // `?project=<id>` starts the chat inside a project; the send authorizes it.
    ...(typeof search["project"] === "string" && search["project"].length <= 128
      ? { project: search["project"] }
      : {}),
  }),
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(chatModelsQuery),
      context.queryClient.prefetchQuery(agentsQuery),
      // The composer's collection and skill pickers mount with the view, so
      // they fetch on arrival either way; started here they overlap the rest.
      context.queryClient.prefetchQuery(knowledgeCollectionsQuery),
      context.queryClient.prefetchQuery(skillsQuery),
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
  const { agent, skill, temporary, project } = Route.useSearch();
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
      key={JSON.stringify([agent, skill, project])}
      user={user}
      temporary={temporary === 1}
      projectId={project ?? null}
      onTemporaryChange={(next) =>
        void router.navigate({
          to: "/",
          search: ({ agent: a, skill: s, project: p }) => ({
            ...(a !== undefined ? { agent: a } : {}),
            ...(s !== undefined ? { skill: s } : {}),
            ...(p !== undefined ? { project: p } : {}),
            ...(next ? { temporary: 1 as const } : {}),
          }),
          replace: true,
        })
      }
      initialAgentId={agent ?? null}
      initialSkillId={skill ?? null}
      initialPrefill={readChatPrefill(location.state.chatPrefill)}
      onPrefillConsumed={consumePrefill}
    />
  );
}
