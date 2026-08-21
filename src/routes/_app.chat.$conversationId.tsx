import { createFileRoute } from "@tanstack/react-router";
import { conversationQuery } from "~/modules/chat/client/queries.ts";
import { ChatView } from "~/modules/chat/ui/chat-view.tsx";

export const Route = createFileRoute("/_app/chat/$conversationId")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(conversationQuery(params.conversationId)),
  component: ChatPage,
});

function ChatPage() {
  const { conversationId } = Route.useParams();
  return <ChatView conversationId={conversationId} />;
}
