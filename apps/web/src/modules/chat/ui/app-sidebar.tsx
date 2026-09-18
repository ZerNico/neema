import {
  BubbleChatIcon,
  Book02Icon,
  FolderLibraryIcon,
  Robot01Icon,
  MoreHorizontalIcon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { Link, useParams, useRouterState } from "@tanstack/react-router";
import { Suspense, useMemo, useState } from "react";
import { AccountMenu } from "~/modules/auth/account-menu.tsx";
import { conversationsInfiniteQuery } from "../client/queries.ts";
import { ConversationMenu, useConversationActions } from "./conversation-actions.tsx";
import { createTitleRevealRegistry } from "./conversation-title.tsx";
import { ConversationStatusTitle } from "./conversation-status-title.tsx";
import { InfiniteSentinel } from "./infinite-sentinel.tsx";
import { groupConversationsByDate } from "./conversation-groups.ts";
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
  const onChatsPage = trimmed === "/chats";
  const onAgentsPage = trimmed.startsWith("/agents");
  const onKnowledgePage = trimmed.startsWith("/knowledge");

  return (
    <Sidebar>
      <SidebarHeader>
        <Link to="/" className={cn(buttonVariants({ variant: "outline" }), "justify-start")}>
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
          New chat
        </Link>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={onAgentsPage} render={<Link to="/agents" />}>
              <HugeiconsIcon icon={Robot01Icon} strokeWidth={2} />
              Agents
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={onKnowledgePage} render={<Link to="/knowledge" />}>
              <HugeiconsIcon icon={FolderLibraryIcon} strokeWidth={2} />
              Knowledge
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={trimmed.startsWith("/skills")}
              render={<Link to="/skills" />}
            >
              <HugeiconsIcon icon={Book02Icon} strokeWidth={2} />
              Skills
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={onChatsPage} render={<Link to="/chats" />}>
              <HugeiconsIcon icon={BubbleChatIcon} strokeWidth={2} />
              Chats
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      {/* Match the chat scroller's soft edge; padding keeps the first and last
          items outside the fade when the list is scrolled to either end. */}
      {/* oxlint-disable-next-line shadcn/no-restyle -- the padding keeps items clear of the mask */}
      <SidebarContent className="py-3 [mask-image:linear-gradient(to_bottom,transparent,black_0.75rem,black_calc(100%-0.75rem),transparent)]">
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
    </Sidebar>
  );
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
  const conversationsPages = useSuspenseInfiniteQuery(conversationsInfiniteQuery(""));
  const params = useParams({ strict: false });
  const activeId = "conversationId" in params ? params.conversationId : undefined;
  // One registry for the whole shell: rows come and go with refetches, the
  // record of which titles already played their reveal must not.
  const [revealRegistry] = useState(createTitleRevealRegistry);
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

  return (
    <>
      {groups.map((group) => (
        <SidebarGroup key={group.label}>
          <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {group.conversations.map((conversation) => (
                <SidebarMenuItem key={conversation.id}>
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
                      branched={!!conversation.branchedFrom}
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
                </SidebarMenuItem>
              ))}
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
