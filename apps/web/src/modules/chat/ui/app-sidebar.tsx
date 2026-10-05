import {
  BubbleChatIcon,
  Book02Icon,
  Calendar03Icon,
  Folder01Icon,
  FolderLibraryIcon,
  Robot01Icon,
  MoreHorizontalIcon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { capabilitiesQuery } from "~/modules/groups/client/queries.ts";
import { Link, useParams, useRouterState } from "@tanstack/react-router";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { Suspense, useMemo, useState } from "react";
import { AccountMenu } from "~/modules/auth/account-menu.tsx";
import { conversationQuery, conversationsInfiniteQuery } from "../client/queries.ts";
import { ConversationMenu } from "./conversation-actions.tsx";
import { useConversationActions } from "./use-conversation-actions.tsx";
import { createTitleRevealRegistry } from "./title-reveal-registry.ts";
import { ConversationStatusTitle } from "./conversation-status-title.tsx";
import { useBrowsingChats } from "~/modules/browser/client/use-browsing-chats.ts";
import { InfiniteSentinel } from "./infinite-sentinel.tsx";
import { groupConversationsByDate } from "./conversation-groups.ts";
import { NeemaGlyph } from "~/ui/brand.tsx";
import { buttonVariants } from "~/ui/primitives/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "~/ui/primitives/sidebar";
import { ProjectsSidebarGroup } from "~/modules/projects/ui/projects-sidebar.tsx";
import { ClosesOnLink } from "~/ui/sidebar-links.tsx";
import { collapseMotion } from "~/ui/motion-presets.ts";
import { useAppReducedMotion } from "~/ui/reduced-motion.ts";
import { cn } from "~/ui/utils";

export function AppSidebar({
  user,
  impersonating = false,
}: {
  user: { id: string; name: string; email: string; role?: string | null | undefined };
  impersonating?: boolean;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const trimmed = pathname.replace(/\/$/, "");
  const { data: capabilities } = useQuery(capabilitiesQuery);
  const destinations = [
    { to: "/projects", label: "Projects", icon: Folder01Icon, shown: capabilities?.projectsUse },
    { to: "/agents", label: "Agents", icon: Robot01Icon, shown: capabilities?.agentsUse },
    {
      to: "/knowledge",
      label: "Knowledge",
      icon: FolderLibraryIcon,
      shown: capabilities?.knowledgeUse,
    },
    { to: "/schedules", label: "Schedules", icon: Calendar03Icon, shown: capabilities?.schedules },
    { to: "/skills", label: "Skills", icon: Book02Icon, shown: capabilities?.skillsUse },
    { to: "/chats", label: "Chats", icon: BubbleChatIcon, shown: true },
  ].filter((destination) => destination.shown);

  return (
    <Sidebar>
      <ClosesOnLink>
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton render={<Link to="/" />}>
                <span className="bg-sidebar-primary text-sidebar-primary-foreground flex size-6 items-center justify-center rounded-md">
                  <NeemaGlyph className="size-4" />
                </span>
                <span className="font-semibold">neema</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <Link to="/" className={cn(buttonVariants({ variant: "outline" }), "justify-start")}>
            <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
            New chat
          </Link>
          {/* Tiles keep every destination one labelled click away in two rows,
            leaving the height to the chat list. */}
          {/* oxlint-disable-next-line shadcn/no-restyle -- a tile grid, not the menu's vertical list */}
          <SidebarMenu className={cn("grid gap-1", tileColumns(destinations.length))}>
            {destinations.map((destination) => (
              <SidebarMenuItem key={destination.to}>
                <SidebarMenuButton
                  size="tile"
                  isActive={trimmed.startsWith(destination.to)}
                  render={<Link to={destination.to} />}
                >
                  <HugeiconsIcon icon={destination.icon} strokeWidth={2} />
                  {destination.label}
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarHeader>
        {/* Match the chat scroller's soft edge; padding keeps the first and last
          items outside the fade when the list is scrolled to either end. */}
        {/* oxlint-disable-next-line shadcn/no-restyle -- the padding keeps items clear of the mask */}
        <SidebarContent className="pb-3 [mask-image:linear-gradient(to_bottom,transparent,black_0.75rem,black_calc(100%-0.75rem),transparent)]">
          {/* The route loader prefetches the first page, so this only shows on
            a cold cache (e.g. right after sign-out emptied it). */}
          <Suspense fallback={<ConversationListSkeleton />}>
            <ConversationList />
          </Suspense>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <AccountMenu user={user} impersonating={impersonating} />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </ClosesOnLink>
    </Sidebar>
  );
}

// Four tiles read better as two pairs than as three and a straggler.
function tileColumns(count: number) {
  if (count >= 5) return "grid-cols-3";
  if (count === 4 || count === 2) return "grid-cols-2";
  return count === 3 ? "grid-cols-3" : "grid-cols-1";
}

function ConversationListSkeleton() {
  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {Array.from({ length: 5 }, (_, index) => (
            <SidebarMenuItem key={index}>
              <SidebarMenuSkeleton />
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

// The suspending half of the sidebar: everything above and below it renders
// while the first page of conversations is still on its way.
function ConversationList() {
  const conversationsPages = useSuspenseInfiniteQuery(
    // A project's chats sit under the project, never also in the dated list.
    conversationsInfiniteQuery("", true),
  );
  const params = useParams({ strict: false });
  const activeId = "conversationId" in params ? params.conversationId : undefined;
  // One registry for the whole shell: rows come and go with refetches, the
  // record of which titles already played their reveal must not.
  const [revealRegistry] = useState(createTitleRevealRegistry);
  const browsing = useBrowsingChats();
  const [mountedAt] = useState(Date.now);
  const rowMotion = collapseMotion(useAppReducedMotion());
  const actions = useConversationActions();
  // The rows are already bucketed by recency, so an inline stamp would only
  // repeat the group heading in a 16rem column. The exact time lives in the
  // row's tooltip instead.

  const pages = conversationsPages.data.pages;
  // Between two page fetches a chat that just received a message can appear on
  // both. Dedupe so React never sees a repeated key before the next
  // invalidation re-pages the list.
  const conversations = useMemo(() => {
    const seen = new Set<string>();
    return pages
      .flatMap((page) => page.conversations)
      .filter((conversation) => !seen.has(conversation.id) && seen.add(conversation.id));
  }, [pages]);

  // Recomputed only when the list changes: the boundaries move at midnight,
  // and any activity (or a navigation) refetches long before that matters.
  const groups = useMemo(() => groupConversationsByDate(conversations), [conversations]);

  // The open chat's detail is already loaded by its route; its project opens
  // that project's entry, so the chat is always visible somewhere.
  const { data: activeDetail } = useQuery({
    ...conversationQuery(activeId ?? ""),
    enabled: false,
  });
  const activeProjectId = activeDetail?.project?.id ?? null;

  return (
    <>
      <ProjectsSidebarGroup activeConversationId={activeId} activeProjectId={activeProjectId} />
      {groups.map((group) => (
        <SidebarGroup key={group.label}>
          <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <AnimatePresence initial={false}>
                {group.conversations.map((conversation) => (
                  <SidebarMenuItem key={conversation.id}>
                    <m.div
                      {...rowMotion}
                      // Only a chat created since the list mounted grows in; one
                      // arriving from a later page or another group just appears.
                      {...(new Date(conversation.createdAt).getTime() > mountedAt
                        ? {}
                        : { initial: false })}
                    >
                      <SidebarMenuButton
                        isActive={conversation.id === activeId}
                        // oxlint-disable-next-line shadcn/no-restyle -- ConversationStatusTitle brings its own spacing between status icon and title
                        className="gap-0 [&>span:last-child]:!text-clip"
                        render={
                          <Link
                            to="/chat/$conversationId"
                            params={{ conversationId: conversation.id }}
                          />
                        }
                      >
                        <ConversationStatusTitle
                          generating={conversation.generating}
                          browsing={browsing.has(conversation.id)}
                          branched={!!conversation.branchedFrom}
                          scheduled={conversation.scheduled}
                          conversationId={conversation.id}
                          title={conversation.title}
                          registry={revealRegistry}
                          createdAt={conversation.createdAt}
                        />
                      </SidebarMenuButton>
                      <ConversationMenu
                        conversation={conversation}
                        actions={actions}
                        trigger={<SidebarMenuAction showOnHover aria-label="Chat actions" />}
                      >
                        <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                      </ConversationMenu>
                    </m.div>
                  </SidebarMenuItem>
                ))}
              </AnimatePresence>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
      {conversations.length === 0 ? (
        <div className="text-muted-foreground flex flex-col gap-1 px-4 py-3 text-sm">
          <span className="text-foreground font-medium">No chats yet</span>
          <span>Start one from the composer and it will show up here.</span>
        </div>
      ) : (
        <InfiniteSentinel
          className="px-2 pb-2"
          hasNext={conversationsPages.hasNextPage}
          isFetching={conversationsPages.isFetchingNextPage}
          onLoadMore={() => void conversationsPages.fetchNextPage()}
        />
      )}
      {actions.renameDialog}
    </>
  );
}
