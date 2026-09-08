import { createFileRoute } from "@tanstack/react-router";
import { agentsQuery } from "~/modules/agents/client/queries.ts";
import { NewChatView } from "~/modules/chat/ui/chat-view.tsx";
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
  loader: async ({ context }) => {
    await Promise.all([
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
  return (
    <NewChatView
      key={JSON.stringify([agent, skill])}
      user={user}
      initialAgentId={agent ?? null}
      initialSkillId={skill ?? null}
    />
  );
}
