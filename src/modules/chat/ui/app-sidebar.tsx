import {
  BubbleChatIcon,
  Logout03Icon,
  GitBranchIcon,
  PlusSignIcon,
  Settings02Icon,
  UserCircleIcon,
  UserIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { authClient } from "~/modules/auth/client.ts";
import { conversationsInfiniteQuery } from "../client/queries.ts";
import { ConversationMenuItems, useConversationActions } from "./conversation-actions.tsx";
import { ConversationTitle, createTitleRevealRegistry } from "./conversation-title.tsx";
import { InfiniteSentinel } from "./infinite-sentinel.tsx";
import { groupConversationsByDate } from "./conversation-groups.ts";
import { describeActivity } from "./timestamps.ts";
import { Avatar, AvatarFallback } from "~/ui/primitives/avatar";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
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
} from "~/ui/primitives/sidebar";

export function AppSidebar({
  user,
}: {
  user: { id: string; name: string; email: string; role?: string | null | undefined };
}) {
  const navigate = useNavigate();
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

  const isAdmin = user.role === "admin";

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
    <Sidebar>
      <SidebarHeader>
        <Button
          variant="outline"
          className="justify-start gap-2"
          nativeButton={false}
          render={<Link to="/" />}
        >
          <HugeiconsIcon icon={PlusSignIcon} className="size-4" />
          New chat
        </Button>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<Link to="/chats" />}>
              <HugeiconsIcon icon={BubbleChatIcon} className="size-4" />
              Chats
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
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
                      {conversation.branchedFrom ? (
                        <HugeiconsIcon
                          icon={GitBranchIcon}
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
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={<SidebarMenuAction showOnHover aria-label="Chat actions" />}
                      >
                        …
                      </DropdownMenuTrigger>
                      <DropdownMenuContent side="right" align="start">
                        <ConversationMenuItems conversation={conversation} actions={actions} />
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
        {conversations.length === 0 ? (
          <div className="text-muted-foreground flex flex-col gap-1 px-4 py-3 text-sm">
            <span className="text-foreground font-medium">No chats yet</span>
            <span>Ask something in the composer and it will show up here.</span>
          </div>
        ) : (
          <InfiniteSentinel
            className="px-2 pb-2"
            hasNext={conversationsPages.hasNextPage}
            isFetching={conversationsPages.isFetchingNextPage}
            onLoadMore={() => void conversationsPages.fetchNextPage()}
          />
        )}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger render={<SidebarMenuButton size="lg" />}>
                <Avatar className="size-8">
                  <AvatarFallback>
                    {user.name.slice(0, 2).toUpperCase() || <HugeiconsIcon icon={UserIcon} />}
                  </AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{user.name}</span>
                  <span className="text-muted-foreground truncate text-xs">{user.email}</span>
                </div>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-56">
                <DropdownMenuItem render={<Link to="/settings" />}>
                  <HugeiconsIcon icon={UserCircleIcon} className="size-4" />
                  Settings
                </DropdownMenuItem>
                {isAdmin ? (
                  <DropdownMenuItem render={<Link to="/admin" />}>
                    <HugeiconsIcon icon={Settings02Icon} className="size-4" />
                    Admin
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                <div
                  className="flex items-center px-2 py-1.5"
                  // Keep the menu open while switching themes.
                  onClick={(e) => e.stopPropagation()}
                >
                  <ThemeSwitch className="w-full" />
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={async () => {
                    await authClient.signOut();
                    await navigate({ to: "/login" });
                  }}
                >
                  <HugeiconsIcon icon={Logout03Icon} className="size-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      {actions.renameDialog}
    </Sidebar>
  );
}
