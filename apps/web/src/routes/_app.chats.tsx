import { createFileRoute } from "@tanstack/react-router";
import { conversationsInfiniteQuery } from "~/modules/chat/client/queries.ts";
import { ChatsPage } from "~/modules/chat/ui/chats-page.tsx";

export const Route = createFileRoute("/_app/chats")({
  loader: async ({ context }) => {
    // The unsearched first page; every narrowing after this keeps the previous
    // results on screen, so this is the only window that would render blank.
    await context.queryClient.ensureInfiniteQueryData(conversationsInfiniteQuery());
  },
  component: ChatsPage,
});
