import { useQuery } from "@tanstack/react-query";
import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { sessionUserQuery } from "~/modules/auth/client.ts";
import { AppSidebar } from "~/modules/chat/ui/app-sidebar.tsx";
import { conversationsInfiniteQuery } from "~/modules/chat/client/queries.ts";
import { useSync } from "~/modules/sync/client/use-sync.ts";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { DetailPanelProvider, DetailPanelRail } from "~/ui/detail-panel.tsx";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "~/ui/primitives/sidebar";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.ensureQueryData(sessionUserQuery);
    if (!user) throw redirect({ to: "/login" });
    return { user };
  },
  loader: async ({ context }) => {
    await context.queryClient.ensureInfiniteQueryData(conversationsInfiniteQuery(""));
    return { user: context.user };
  },
  component: AppLayout,
});

function AppLayout() {
  const { user } = Route.useLoaderData();
  useSync();

  return (
    <ConfirmProvider>
      <SidebarProvider>
        <SessionAppSidebar initialUser={user} />
        <SidebarInset className="h-svh overflow-hidden">
          <DetailPanelProvider>
            <header className="flex h-12 shrink-0 items-center gap-2 px-3">
              <SidebarTrigger />
            </header>
            {/* The detail rail is a sibling of the content, not an overlay:
                opening it shrinks the chat column instead of covering it. */}
            <div className="flex min-h-0 flex-1">
              <main className="min-w-0 flex-1">
                <Outlet />
              </main>
              <DetailPanelRail />
            </div>
          </DetailPanelProvider>
        </SidebarInset>
      </SidebarProvider>
    </ConfirmProvider>
  );
}

export function SessionAppSidebar({
  initialUser,
}: {
  initialUser: Parameters<typeof AppSidebar>[0]["user"];
}) {
  const { data: sessionUser } = useQuery(sessionUserQuery);
  return <AppSidebar user={sessionUser ?? initialUser} />;
}
