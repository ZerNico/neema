import { createFileRoute } from "@tanstack/react-router";
import { archivedConversationsQuery } from "~/modules/chat/client/queries.ts";
import { ArchivedChatsPage } from "~/modules/settings/ui/archived-chats-page.tsx";

export const Route = createFileRoute("/_app/settings/archived")({
  loader: ({ context }) => context.queryClient.ensureQueryData(archivedConversationsQuery),
  component: ArchivedChatsPage,
});
