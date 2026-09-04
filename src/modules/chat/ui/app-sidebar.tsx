import {
  BubbleChatIcon,
  Logout03Icon,
  GitBranchIcon,
  MoreHorizontalIcon,
  PlusSignIcon,
  Settings02Icon,
  UserCircleIcon,
  UserIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQueryClient, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { Suspense, useMemo, useState } from "react";
import { toast } from "sonner";
import { authClient } from "~/modules/auth/client.ts";
import { conversationsInfiniteQuery } from "../client/queries.ts";
import { ConversationMenu, useConversationActions } from "./conversation-actions.tsx";
import { ConversationTitle, createTitleRevealRegistry } from "./conversation-title.tsx";
import { InfiniteSentinel } from "./infinite-sentinel.tsx";
import { groupConversationsByDate } from "./conversation-groups.ts";
import { describeActivity } from "./timestamps.ts";
import { Avatar, AvatarFallback } from "~/ui/primitives/avatar";
import { buttonVariants } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Spinner } from "~/ui/primitives/spinner";
import { ThemeSwitch } from "~/ui/theme-switch.tsx";
import { useHydrated } from "~/ui/use-hydrated.ts";
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
}: {
  user: { id: string; name: string; email: string; role?: string | null | undefined };
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const onChatsPage = pathname.replace(/\/$/, "") === "/chats";

  const isAdmin = user.role === "admin";

  return (
    <Sidebar>
      <SidebarHeader>
        <Link to="/" className={cn(buttonVariants({ variant: "outline" }), "justify-start")}>
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
          New chat
        </Link>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={onChatsPage} render={<Link to="/chats" />}>
              <HugeiconsIcon icon={BubbleChatIcon} strokeWidth={2} />
              Chats
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {/* The route loader prefetches the first page, so this only shows on
            a cold cache (e.g. right after sign-out emptied it). */}
        <Suspense fallback={<ConversationListSkeleton />}>
          <ConversationList />
        </Suspense>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger render={<SidebarMenuButton size="lg" />}>
                <Avatar className="size-8">
                  <AvatarFallback>
                    {user.name.slice(0, 2).toUpperCase() || (
                      <HugeiconsIcon icon={UserIcon} strokeWidth={2} className="size-4" />
                    )}
                  </AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{user.name}</span>
                  <span className="text-muted-foreground truncate text-xs">{user.email}</span>
                </div>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-56">
                <DropdownMenuItem render={<Link to="/settings" />}>
                  <HugeiconsIcon icon={UserCircleIcon} strokeWidth={2} />
                  Settings
                </DropdownMenuItem>
                {isAdmin ? (
                  <DropdownMenuItem render={<Link to="/admin" />}>
                    <HugeiconsIcon icon={Settings02Icon} strokeWidth={2} />
                    Admin
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                {/* Same inset as a DropdownMenuItem so the switch lines up
                    with the rows around it. */}
                <div
                  className="flex items-center px-3 py-2"
                  // Keep the menu open while switching themes.
                  onClick={(e) => e.stopPropagation()}
                >
                  <ThemeSwitch className="w-full" />
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={async () => {
                    const { error } = await authClient.signOut();
                    if (error) {
                      toast.error("Could not sign out.");
                      return;
                    }
                    // The cache outlives the route, so signing out has to empty
                    // it: the session, this list of conversations and every
                    // conversation read through it all belong to the account
                    // that just left.
                    queryClient.clear();
                    await navigate({ to: "/login" });
                  }}
                >
                  <HugeiconsIcon icon={Logout03Icon} strokeWidth={2} />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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
  // row's tooltip instead — held back until hydration, because formatting it
  // on the server would produce an attribute in the wrong timezone.
  const hydrated = useHydrated();

  const pages = conversationsPages.data.pages;
  // Between two page fetches a chat that just received a message can appear on
  // both — dedupe so React never sees a repeated key before the next
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
                    render={
                      <Link
                        to="/chat/$conversationId"
                        params={{ conversationId: conversation.id }}
                        {...(hydrated ? { title: describeActivity(conversation) } : {})}
                      />
                    }
                  >
                    {/* The spinner borrows the branch icon's slot: while an
                        answer streams, "busy" is the state worth a glance. */}
                    {conversation.generating ? (
                      <Spinner aria-label="Generating" className="text-muted-foreground shrink-0" />
                    ) : conversation.branchedFrom ? (
                      <HugeiconsIcon
                        icon={GitBranchIcon}
                        strokeWidth={2}
                        className="text-muted-foreground shrink-0"
                        aria-label="Branched conversation"
                      />
                    ) : null}
                    <ConversationTitle
                      conversationId={conversation.id}
                      title={conversation.title}
                      registry={revealRegistry}
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
