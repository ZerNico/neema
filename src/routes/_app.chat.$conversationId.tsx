import { Loading03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { createFileRoute } from "@tanstack/react-router";
import { chatModelsQuery, conversationQuery } from "~/modules/chat/client/queries.ts";
import { ChatView } from "~/modules/chat/ui/chat-view.tsx";

export const Route = createFileRoute("/_app/chat/$conversationId")({
  // Both blocking queries start together. The model list is a suspense read
  // inside the view (the composer's search toggle), so leaving it out here
  // would queue a second cold round trip after the conversation lands.
  // Nothing is returned: the view reads both from the query cache, and the
  // SSR query integration already dehydrates them — returning the payload
  // would serialize the whole conversation into the document a second time.
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(conversationQuery(params.conversationId)),
      context.queryClient.ensureQueryData(chatModelsQuery),
    ]);
  },
  component: ChatPage,
  // A click that beats link preloading otherwise leaves the previous chat on
  // screen with no sign anything happened. 200ms is past a warm open, so a
  // preloaded or cached conversation never flashes this; no minimum, so it
  // leaves the moment the data is there.
  pendingComponent: ChatPending,
  pendingMs: 200,
  pendingMinMs: 0,
});

function ChatPage() {
  const { conversationId } = Route.useParams();
  return <ChatView key={conversationId} conversationId={conversationId} />;
}

function ChatPending() {
  return (
    <div role="status" className="flex h-full items-center justify-center">
      <HugeiconsIcon
        icon={Loading03Icon}
        className="text-muted-foreground size-5 animate-spin"
        aria-label="Loading conversation"
      />
    </div>
  );
}
