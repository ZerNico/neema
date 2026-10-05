import { IntegrationApprovalNotifier } from "~/modules/integrations/ui/integration-approval-notifier.tsx";
import {
  DesktopWorkProvider,
  WorkAttention,
  WorkConnectionNotice,
} from "~/modules/desktop/client/work-host.tsx";
import { useQuery } from "@tanstack/react-query";
import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { useDesktopSessionRefresh } from "~/modules/auth/desktop-session-refresh.ts";
import { IdentityBoundary } from "~/modules/auth/identity-boundary.tsx";
import { useIdentityBoundary } from "~/modules/auth/identity-context.ts";
import type { SessionIdentity } from "~/modules/auth/identity.ts";
import {
  approvalStatusQuery,
  sessionIdentityQuery,
  sessionUserQuery,
} from "~/modules/auth/client.ts";
import { AppSidebar } from "~/modules/chat/ui/app-sidebar.tsx";
import { conversationsInfiniteQuery } from "~/modules/chat/client/queries.ts";
import { useSync } from "~/modules/sync/client/use-sync.ts";
import { FeatureTourProvider } from "~/modules/help/ui/feature-tour.tsx";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { AppMotionProvider } from "~/ui/motion.tsx";
import { AppHeader, TitlebarCorner } from "~/ui/desktop-chrome.tsx";
import { HistoryButtons } from "~/ui/history-buttons.tsx";
import {
  DetailPanelProvider,
  DetailPanelRail,
  DetailPanelToggle,
  PanelToggleSpace,
} from "~/ui/detail-panel.tsx";
import { HeaderSlot, HeaderSlotProvider } from "~/ui/header-slot.tsx";
import { useDesktopBrowser } from "~/modules/browser/client/use-desktop-browser.ts";
import { BrowserHost } from "~/modules/browser/ui/browser-host.tsx";
import { browserNewTab } from "~/modules/browser/ui/browser-request.tsx";
import { BrowserPanelOwner } from "~/modules/browser/ui/browser-tab.tsx";
import { CommandPaletteProvider, SearchButton } from "~/modules/search/ui/command-palette.tsx";
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
    await context.queryClient.ensureInfiniteQueryData(conversationsInfiniteQuery("", true));
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
  const browser = useDesktopBrowser();
  useSync(boundary?.reconcile);
  useDesktopSessionRefresh();

  return (
    <DesktopWorkProvider userId={identity.userId}>
      <AppMotionProvider>
        <ConfirmProvider>
          <FeatureTourProvider enabled={!identity.impersonatedBy}>
            <SidebarProvider>
              <CommandPaletteProvider>
                <SessionAppSidebar initialUser={user} impersonating={!!identity.impersonatedBy} />
                <SidebarInset className="h-svh overflow-hidden">
                  <DetailPanelProvider
                    userId={identity.userId}
                    {...(browser ? { newTab: browserNewTab } : {})}
                  >
                    <BrowserHost />
                    <BrowserPanelOwner />
                    <HeaderSlotProvider>
                      {/* The detail rail is a sibling of the page column, header
                          included, so it runs the full height and opening it
                          shrinks the chat instead of covering it. */}
                      <div className="relative flex min-h-0 flex-1">
                        <div className="flex min-w-0 flex-1 flex-col">
                          <AppHeader>
                            <SidebarTrigger />
                            <HistoryButtons />
                            <SearchButton />
                            <HeaderSlot />
                            <WorkAttention />
                            <PanelToggleSpace inHeader />
                          </AppHeader>
                          <IntegrationApprovalNotifier />
                          <WorkConnectionNotice />
                          <main className="min-h-0 min-w-0 flex-1">
                            <Outlet />
                          </main>
                        </div>
                        <DetailPanelRail />
                        <TitlebarCorner>
                          <DetailPanelToggle />
                        </TitlebarCorner>
                      </div>
                    </HeaderSlotProvider>
                  </DetailPanelProvider>
                </SidebarInset>
              </CommandPaletteProvider>
            </SidebarProvider>
          </FeatureTourProvider>
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
