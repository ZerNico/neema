import { IntegrationApprovalNotifier } from "~/modules/integrations/ui/integration-approval-notifier.tsx";
import {
  DesktopWorkProvider,
  WorkAttention,
  WorkConnectionNotice,
} from "~/modules/desktop/client/work-host.tsx";
import { useCallback, type CSSProperties } from "react";
import { Outlet, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { redirectSearch, safeRedirect } from "~/modules/auth/redirect.ts";
import { useDesktopSessionRefresh } from "~/modules/auth/desktop-session-refresh.ts";
import { IdentityBoundary } from "~/modules/auth/identity-boundary.tsx";
import { useIdentityBoundary } from "~/modules/auth/identity-context.ts";
import { cacheOwnerOf, type SessionIdentity } from "~/modules/auth/identity.ts";
import { setDeviceCacheOwner } from "~/modules/cache/client/device-cache.ts";
import { meQuery, useSessionUser } from "~/modules/auth/client.ts";
import { alignLanguage } from "~/modules/language/client/language.ts";
import { AppSidebar } from "~/modules/chat/ui/app-sidebar.tsx";
import { conversationsInfiniteQuery } from "~/modules/chat/client/queries.ts";
import { sidebarPinsQuery } from "~/modules/navigation/client/queries.ts";
import { capabilitiesQuery } from "~/modules/groups/client/queries.ts";
import { closeSyncFeed, openSyncFeed } from "~/modules/sync/client/feed.ts";
import { useSync } from "~/modules/sync/client/use-sync.ts";
import { usePush } from "~/modules/notifications/client/push.ts";
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
import { AppViewReturns } from "~/modules/app-use/ui/app-view-owner.tsx";
import { BrowserPanelOwner } from "~/modules/browser/ui/browser-tab.tsx";
import { CommandPaletteProvider, SearchButton } from "~/modules/search/ui/command-palette.tsx";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "~/ui/primitives/sidebar";

/** The sign-in page's `redirect`, left out for the home page it returns to anyway. */
const returnTo = (href: string | undefined) =>
  redirectSearch(href === "/" ? undefined : safeRedirect(href));

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    // Subscribed while the session is checked, so the loaders read after it and
    // the first sync open has nothing to refetch. Browser only, like the cache owner.
    const feed = typeof window === "undefined" ? undefined : openSyncFeed();
    try {
      const me = await context.queryClient.ensureQueryData(meQuery);
      // Back to where they were going once signed in: a deep link, or what was shared.
      if (!me) throw redirect({ to: "/login", search: returnTo(location?.href) });
      // Every server function this tree loads would refuse an unapproved
      // account, so it is turned away before any of them runs.
      if (me.approval !== "approved") throw redirect({ to: "/pending" });
      const { user, identity } = me;
      // Known before anything renders, so a cache can be read for the first frame.
      // Browser only: on a server, module state would be shared by every request.
      if (typeof window !== "undefined") {
        setDeviceCacheOwner(cacheOwnerOf(identity));
        await alignLanguage(context.queryClient);
      }
      await feed;
      return { user, identity };
    } catch (error) {
      closeSyncFeed();
      throw error;
    }
  },
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureInfiniteQueryData(conversationsInfiniteQuery("", true)),
      // The rail shows a pin only for a page the person may open, so both
      // arrive before it renders, or the pins would animate in after it.
      context.queryClient.ensureQueryData(sidebarPinsQuery),
      context.queryClient.ensureQueryData(capabilitiesQuery),
    ]);
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
  const router = useRouter();
  const openPath = useCallback((path: string) => router.history.push(path), [router]);
  useSync(boundary?.reconcile, openPath);
  usePush(openPath);
  useDesktopSessionRefresh();

  return (
    <DesktopWorkProvider userId={identity.userId}>
      <AppMotionProvider>
        <ConfirmProvider>
          <FeatureTourProvider enabled={!identity.impersonatedBy}>
            {/* A fixed height, so the inset page stretches to it less its margins. */}
            <SidebarProvider
              className="h-svh"
              style={{ "--sidebar-width": "var(--app-sidebar-width)" } as CSSProperties}
            >
              <CommandPaletteProvider>
                <SessionAppSidebar initialUser={user} impersonating={!!identity.impersonatedBy} />
                <SidebarInset className="min-h-0 overflow-hidden">
                  <DetailPanelProvider
                    userId={identity.userId}
                    {...(browser ? { newTab: browserNewTab } : {})}
                  >
                    <BrowserHost />
                    <BrowserPanelOwner />
                    <AppViewReturns />
                    <HeaderSlotProvider>
                      {/* The detail rail is a sibling of the page column, header
                          included, so it runs the full height and opening it
                          shrinks the chat instead of covering it. */}
                      <div className="relative flex min-h-0 flex-1">
                        {/* Covered by a full-width rail, the page is hidden and skips layout, so a
                            sidebar moving beside the rail never re-lays out the chat. It keeps its state. */}
                        <div className="flex min-w-0 flex-1 flex-col [html[data-panel-expanded]_&]:invisible [html[data-panel-expanded]_&]:overflow-hidden [html[data-panel-expanded]_&]:[content-visibility:hidden]">
                          <AppHeader>
                            {/* On a wide screen the toggle heads the rail. */}
                            <SidebarTrigger className="md:hidden" />
                            {/* The app's own controls, kept beside a full-width rail (app.css). */}
                            <div data-header-controls="" className="contents">
                              <HistoryButtons />
                              <SearchButton />
                            </div>
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
  const sessionUser = useSessionUser();
  if (sessionUser === null || (sessionUser && sessionUser.id !== initialUser.id)) return null;
  return (
    <AppSidebar
      user={sessionUser === undefined ? initialUser : sessionUser}
      impersonating={impersonating}
    />
  );
}
