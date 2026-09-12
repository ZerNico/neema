import { BubbleChatCancelIcon } from "@hugeicons/core-free-icons";
import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import {
  chatModelsQuery,
  conversationQuery,
  webSearchAvailabilityQuery,
  researchAvailabilityQuery,
} from "~/modules/chat/client/queries.ts";
import { ChatView } from "~/modules/chat/ui/chat-view.tsx";
import { prepareWorkFolder } from "~/modules/desktop/client/bridge.ts";
import { EmptyState } from "~/ui/page-shell.tsx";
import { buttonVariants } from "~/ui/primitives/button";
import { Spinner } from "~/ui/primitives/spinner";

export const Route = createFileRoute("/_app/chat/$conversationId")({
  // Start the conversation and composer queries together so the model label
  // and search toggle are ready when the view renders, not a round trip later.
  // Nothing is returned: the view reads from the query cache, and the
  // SSR query integration already dehydrates them — returning the payload
  // would serialize the whole conversation into the document a second time.
  loader: async ({ context, params, abortController }) => {
    await Promise.all([
      context.queryClient
        .ensureQueryData(conversationQuery(params.conversationId))
        .then(async (detail) => {
          // Guard cached results too, before the view dereferences the conversation.
          if (!detail?.conversation) throw notFound();
          if (detail.conversation.mode === "work")
            await prepareWorkFolder(
              context.queryClient,
              params.conversationId,
              abortController.signal,
            );
        }),
      context.queryClient.ensureQueryData(chatModelsQuery),
      // Prefetch keeps optional search-config failures out of the route error boundary.
      context.queryClient.prefetchQuery({ ...webSearchAvailabilityQuery, retry: false }),
      context.queryClient.prefetchQuery({ ...researchAvailabilityQuery, retry: false }),
    ]);
  },
  component: ChatPage,
  notFoundComponent: ChatNotFound,
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
    <div className="flex h-full items-center justify-center">
      <Spinner aria-label="Loading conversation" className="size-5 text-muted-foreground" />
    </div>
  );
}

function ChatNotFound() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <EmptyState
        icon={BubbleChatCancelIcon}
        title="Chat not found"
        description="This chat may have been deleted or the link is no longer available."
        className="w-full max-w-lg"
        action={
          <Link to="/chats" className={buttonVariants({ variant: "outline", size: "sm" })}>
            Back to chats
          </Link>
        }
      />
    </div>
  );
}
