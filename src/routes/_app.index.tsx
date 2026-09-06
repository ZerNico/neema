import { createFileRoute } from "@tanstack/react-router";
import { NewChatView } from "~/modules/chat/ui/chat-view.tsx";
import {
  chatModelsQuery,
  researchAvailabilityQuery,
  webSearchAvailabilityQuery,
} from "~/modules/chat/client/queries.ts";

export const Route = createFileRoute("/_app/")({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(chatModelsQuery),
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
  return <NewChatView user={user} />;
}
