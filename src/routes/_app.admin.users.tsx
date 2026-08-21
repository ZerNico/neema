import { createFileRoute } from "@tanstack/react-router";
import { UsersPage } from "~/modules/admin/ui/users-page.tsx";

export const Route = createFileRoute("/_app/admin/users")({
  component: UsersPage,
});
