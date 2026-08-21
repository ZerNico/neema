import { createFileRoute } from "@tanstack/react-router";
import { NewChatView } from "~/modules/chat/ui/chat-view.tsx";

export const Route = createFileRoute("/_app/")({
  component: NewChatView,
});
