import {
  BubbleChatIcon,
  GitBranchIcon,
  MoreHorizontalIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { conversationsInfiniteQuery } from "../client/queries.ts";
import { ConversationMenuItems, useConversationActions } from "./conversation-actions.tsx";
import { ConversationTitle, createTitleRevealRegistry } from "./conversation-title.tsx";
import { InfiniteSentinel } from "./infinite-sentinel.tsx";
import { groupConversationsByDate } from "./conversation-groups.ts";
import { activityStamp, describeActivity } from "./timestamps.ts";
import { AdminPage, EmptyState, ListCard, ListRow } from "~/modules/admin/ui/admin-shell.tsx";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Input } from "~/ui/primitives/input";
import { useHydrated } from "~/ui/use-hydrated.ts";

// Only consumer of a debounce in the repo, so it lives here rather than
// becoming another shared helper.
function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

export function ChatsPage() {
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim(), 250);
  // Not the suspense variant: typing must narrow the list in place, never
  // suspend the page out from under the search box.
  const pages = useInfiniteQuery({
    ...conversationsInfiniteQuery(query),
    placeholderData: keepPreviousData,
  });
  const actions = useConversationActions();
  const [revealRegistry] = useState(createTitleRevealRegistry);
  // Formatting a local timestamp during SSR would use the server's timezone.
  const hydrated = useHydrated();

  const conversations = useMemo(() => {
    const seen = new Set<string>();
    return (pages.data?.pages ?? [])
      .flatMap((page) => page.conversations)
      .filter((conversation) => !seen.has(conversation.id) && seen.add(conversation.id));
  }, [pages.data]);

  // Search results are ranked by recency but browsed as one list — day
  // headings would only chop up an already short set of matches.
  const groups = useMemo(
    () => (query ? [{ label: "", conversations }] : groupConversationsByDate(conversations)),
    [conversations, query],
  );

  const empty = conversations.length === 0 && !pages.isPending;

  return (
    <AdminPage
      title="Chats"
      description="Every conversation you've had, newest first."
      rootPath="/"
      rootLabel="Back to chat"
    >
      <Input
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search chats…"
        aria-label="Search chats"
      />

      {empty ? (
        query ? (
          <EmptyState
            icon={Search01Icon}
            title="No chats match"
            description={`Nothing found for “${query}”. Titles only — message text isn't searched.`}
          />
        ) : (
          <EmptyState
            icon={BubbleChatIcon}
            title="No chats yet"
            description="Start one from the composer and it will show up here."
            action={
              <Button nativeButton={false} render={<Link to="/" />}>
                New chat
              </Button>
            }
          />
        )
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <section key={group.label} className="flex flex-col gap-2">
              {group.label ? (
                <h2 className="text-muted-foreground px-1 text-xs font-medium">{group.label}</h2>
              ) : null}
              <ListCard>
                {group.conversations.map((conversation) => (
                  <ListRow key={conversation.id} className="gap-2 py-2">
                    <Link
                      to="/chat/$conversationId"
                      params={{ conversationId: conversation.id }}
                      className="hover:text-foreground flex min-w-0 flex-1 items-center gap-1.5 text-sm"
                      {...(hydrated ? { title: describeActivity(conversation) } : {})}
                    >
                      {conversation.branchedFrom ? (
                        <HugeiconsIcon
                          icon={GitBranchIcon}
                          className="text-muted-foreground size-3.5 shrink-0"
                          aria-label="Branched conversation"
                        />
                      ) : null}
                      <ConversationTitle
                        conversationId={conversation.id}
                        title={conversation.title}
                        registry={revealRegistry}
                      />
                    </Link>
                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                      {hydrated ? activityStamp(conversation) : ""}
                    </span>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Actions for ${conversation.title ?? "New chat"}`}
                          />
                        }
                      >
                        <HugeiconsIcon icon={MoreHorizontalIcon} className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <ConversationMenuItems conversation={conversation} actions={actions} />
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </ListRow>
                ))}
              </ListCard>
            </section>
          ))}
          <InfiniteSentinel
            hasNext={pages.hasNextPage}
            isFetching={pages.isFetchingNextPage}
            onLoadMore={() => void pages.fetchNextPage()}
          />
        </div>
      )}
      {actions.renameDialog}
    </AdminPage>
  );
}
