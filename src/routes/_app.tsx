import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { getSession } from "~/modules/auth/server/functions.ts";
import { AppSidebar } from "~/modules/chat/ui/app-sidebar.tsx";
import { conversationsQuery } from "~/modules/chat/client/queries.ts";
import { useSync } from "~/modules/sync/client/use-sync.ts";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "~/shared/ui/primitives/sidebar";

export const Route = createFileRoute("/_app")({
  beforeLoad: async () => {
    const session = await getSession();
    if (!session) throw redirect({ to: "/login" });
    return { user: session.user };
  },
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(conversationsQuery);
    return { user: context.user };
  },
  component: AppLayout,
});

function AppLayout() {
  const { user } = Route.useLoaderData();
  useSync();

  return (
    <SidebarProvider>
      <AppSidebar user={user} />
      <SidebarInset className="h-svh overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 px-3">
          <SidebarTrigger />
        </header>
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
