import { createFileRoute } from "@tanstack/react-router";
import { ChatsPage } from "~/modules/chat/ui/chats-page.tsx";

export const Route = createFileRoute("/_app/chats")({
  component: ChatsPage,
});
