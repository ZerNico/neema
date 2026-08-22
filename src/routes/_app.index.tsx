import { createFileRoute } from "@tanstack/react-router";
import { NewChatView } from "~/modules/chat/ui/chat-view.tsx";

export const Route = createFileRoute("/_app/")({
  component: NewChatPage,
});

function NewChatPage() {
  // `user` comes from the parent `_app` route's beforeLoad context.
  const { user } = Route.useRouteContext();
  return <NewChatView user={user} />;
}
