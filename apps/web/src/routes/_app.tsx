import { DesktopWorkProvider, WorkAttention } from "~/modules/desktop/client/work-host.tsx";
import { useQuery } from "@tanstack/react-query";
import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { useDesktopSessionRefresh } from "~/modules/auth/desktop-session-refresh.ts";
import { IdentityBoundary, useIdentityBoundary } from "~/modules/auth/identity-boundary.tsx";
import type { SessionIdentity } from "~/modules/auth/identity.ts";
import {
  approvalStatusQuery,
  sessionIdentityQuery,
  sessionUserQuery,
} from "~/modules/auth/client.ts";
import { AppSidebar } from "~/modules/chat/ui/app-sidebar.tsx";
import { conversationsInfiniteQuery } from "~/modules/chat/client/queries.ts";
import { useSync } from "~/modules/sync/client/use-sync.ts";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { AppMotionProvider } from "~/ui/motion.tsx";
import { AppHeader } from "~/ui/desktop-chrome.tsx";
import { DetailPanelProvider, DetailPanelRail } from "~/ui/detail-panel.tsx";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "~/ui/primitives/sidebar";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.ensureQueryData(sessionUserQuery);
    if (!user) throw redirect({ to: "/login" });
    const identity = await context.queryClient.ensureQueryData(sessionIdentityQuery);
    if (!identity || identity.userId !== user.id) throw redirect({ to: "/login" });
    // Every server function this tree loads would refuse an unapproved
    // account, so it is turned away before any of them runs.
    const approval = await context.queryClient.ensureQueryData(approvalStatusQuery);
    if (approval !== "approved") throw redirect({ to: "/pending" });
    return { user, identity };
  },
  loader: async ({ context }) => {
    await context.queryClient.ensureInfiniteQueryData(conversationsInfiniteQuery(""));
    return { user: context.user, identity: context.identity };
  },
  component: AppLayout,
});

function AppLayout() {
  const { user, identity } = Route.useLoaderData();
  return (
    <IdentityBoundary identity={identity}>
      <AuthenticatedLayout user={user} identity={identity} />
    </IdentityBoundary>
  );
}

function AuthenticatedLayout({
  user,
  identity,
}: {
  user: Parameters<typeof AppSidebar>[0]["user"];
  identity: SessionIdentity;
}) {
  const boundary = useIdentityBoundary();
  useSync(boundary?.reconcile);
  useDesktopSessionRefresh();

  return (
    <DesktopWorkProvider userId={identity.userId}>
      <AppMotionProvider>
        <ConfirmProvider>
          <SidebarProvider>
            <SessionAppSidebar initialUser={user} impersonating={!!identity.impersonatedBy} />
            <SidebarInset className="h-svh overflow-hidden">
              <DetailPanelProvider>
                <AppHeader>
                  <SidebarTrigger />
                  <WorkAttention />
                </AppHeader>
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
      </AppMotionProvider>
    </DesktopWorkProvider>
  );
}

export function SessionAppSidebar({
  initialUser,
  impersonating = false,
}: {
  initialUser: Parameters<typeof AppSidebar>[0]["user"];
  impersonating?: boolean;
}) {
  const { data: sessionUser } = useQuery(sessionUserQuery);
  if (sessionUser === null || (sessionUser && sessionUser.id !== initialUser.id)) return null;
  return (
    <AppSidebar
      user={sessionUser === undefined ? initialUser : sessionUser}
      impersonating={impersonating}
    />
  );
}
