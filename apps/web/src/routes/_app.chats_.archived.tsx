import { createFileRoute } from "@tanstack/react-router";
import { archivedConversationsQuery } from "~/modules/chat/client/queries.ts";
import { ArchivedChatsListPage } from "~/modules/chat/ui/archived-list-page.tsx";

/** `chats_` keeps this out of the Chats page’s layout: a page of its own, not a child. */
export const Route = createFileRoute("/_app/chats_/archived")({
  loader: ({ context }) => context.queryClient.ensureQueryData(archivedConversationsQuery),
  component: ArchivedChatsListPage,
});
