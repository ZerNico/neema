import { prewarmGenui } from "~/modules/genui/client/prewarm.ts";
import { BubbleChatCancelIcon } from "@hugeicons/core-free-icons";
import { Link, createFileRoute, notFound, useLocation, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { agentsQuery } from "~/modules/agents/client/queries.ts";
import {
  chatModelsQuery,
  conversationQuery,
  webSearchAvailabilityQuery,
  researchAvailabilityQuery,
} from "~/modules/chat/client/queries.ts";
import { ChatView } from "~/modules/chat/ui/chat-view.tsx";
import { knowledgeCollectionsQuery } from "~/modules/knowledge/client/queries.ts";
import { skillsQuery } from "~/modules/skills/client/queries.ts";
import { prepareWorkFolder } from "~/modules/desktop/client/bridge.ts";
import { EmptyState } from "~/ui/page-shell.tsx";
import { RouteStatusScreen } from "~/ui/route-error.tsx";
import { buttonVariants } from "~/ui/primitives/button";
import { Spinner } from "~/ui/primitives/spinner";

export const Route = createFileRoute("/_app/chat/$conversationId")({
  // Start the conversation and composer queries together so the model label
  // and search toggle are ready when the view renders, not a round trip later.
  // Nothing is returned: the view reads these from the query cache, so a
  // loader payload would only be a second copy.
  loader: async ({ context, params, abortController }) => {
    await Promise.all([
      context.queryClient
        .ensureQueryData(conversationQuery(params.conversationId))
        .then(async (detail) => {
          // Guard cached results too, before the view dereferences the conversation.
          if (!detail?.conversation) throw notFound();
          // Blocks draw from the renderer's code, the device's cached trees and
          // QuickJS: start them with the data. The code is briefly waited for,
          // so the answer appears whole rather than with placeholders that resize.
          if (detail.messages.some((message) => /(?:```|~~~)ui\b/.test(message.content)))
            // Under the 200 ms pendingMs, so the wait never shows the pending view.
            await Promise.race([prewarmGenui(), new Promise((done) => setTimeout(done, 180))]);
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
      // The composer mounts its agent, collection and skill pickers with the
      // view rather than on open, so all three fetch on arrival regardless.
      // Started here they overlap the conversation instead of trailing it.
      context.queryClient.prefetchQuery(agentsQuery),
      context.queryClient.prefetchQuery(knowledgeCollectionsQuery),
      context.queryClient.prefetchQuery(skillsQuery),
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
  const router = useRouter();
  const location = useLocation();
  // Held per conversation, since the flag leaves the history entry right away
  // and the view may only render once its data is in.
  const opened = { conversationId, anchorFirstTurn: location.state.anchorNewTurn === true };
  const [entry, setEntry] = useState(opened);
  if (entry.conversationId !== conversationId) setEntry(opened);
  const anchorFirstTurn = entry.conversationId === conversationId && entry.anchorFirstTurn;
  // One-shot: a reload or a return to this entry opens the chat as usual.
  useEffect(() => {
    const current = router.history.location;
    if (!current.state.anchorNewTurn) return;
    const { anchorNewTurn: _consumed, ...state } = current.state;
    router.history.replace(current.href, state);
  }, [router]);
  return (
    <ChatView
      key={conversationId}
      conversationId={conversationId}
      anchorFirstTurn={anchorFirstTurn}
    />
  );
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
    <RouteStatusScreen>
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
    </RouteStatusScreen>
  );
}
