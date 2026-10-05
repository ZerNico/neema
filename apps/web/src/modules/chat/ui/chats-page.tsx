import {
  Archive02Icon,
  BubbleChatIcon,
  MoreHorizontalIcon,
  PlusSignIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useMemo, useState } from "react";
import { conversationsInfiniteQuery } from "../client/queries.ts";
import { ConversationMenu } from "./conversation-actions.tsx";
import { useConversationActions } from "./use-conversation-actions.tsx";
import { createTitleRevealRegistry } from "./title-reveal-registry.ts";
import { ConversationStatusTitle } from "./conversation-status-title.tsx";
import { InfiniteSentinel } from "./infinite-sentinel.tsx";
import { groupConversationsByDate } from "./conversation-groups.ts";
import { activityStamp, describeActivity } from "./timestamps.ts";
import { EmptyState, Page, Section } from "~/ui/page-shell.tsx";
import { Button, buttonVariants } from "~/ui/primitives/button";
import { SearchInput } from "~/ui/search-input.tsx";
import { cn } from "~/ui/utils";
import { focusRingClassName } from "~/ui/focus-ring.ts";
import { useDebounced } from "~/ui/use-debounced.ts";
import { MAX_SEARCH_LENGTH } from "~/modules/search/text.ts";

export function ChatsPage() {
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim().slice(0, MAX_SEARCH_LENGTH), 250);
  // Not the suspense variant: typing must narrow the list in place, never
  // suspend the page out from under the search box.
  const pages = useInfiniteQuery({
    ...conversationsInfiniteQuery(query),
    placeholderData: keepPreviousData,
  });
  const actions = useConversationActions();
  const [revealRegistry] = useState(createTitleRevealRegistry);

  const conversations = useMemo(() => {
    const seen = new Set<string>();
    return (pages.data?.pages ?? [])
      .flatMap((page) => page.conversations)
      .filter((conversation) => !seen.has(conversation.id) && seen.add(conversation.id));
  }, [pages.data]);

  // Search results are ranked by recency but browsed as one list, so day
  // headings would only chop up an already short set of matches.
  const groups = useMemo(
    () => (query ? [{ label: "", conversations }] : groupConversationsByDate(conversations)),
    [conversations, query],
  );

  const empty = conversations.length === 0 && !pages.isPending;

  return (
    <Page
      title="Chats"
      rootPath="/"
      rootLabel="Chat"
      actions={
        // Out of the way: archived chats are a place you go to, not a list to compare.
        <Link to="/chats/archived" className={buttonVariants({ variant: "ghost", size: "sm" })}>
          <HugeiconsIcon icon={Archive02Icon} strokeWidth={2} data-icon="inline-start" />
          Archived
        </Link>
      }
    >
      <SearchInput
        maxLength={MAX_SEARCH_LENGTH}
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
            description={`No titles match “${query}”.`}
          />
        ) : (
          <EmptyState
            icon={BubbleChatIcon}
            title="No chats yet"
            description="Your chats will show up here."
            action={
              <Link to="/" className={buttonVariants({ size: "sm" })}>
                <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
                New chat
              </Link>
            }
          />
        )
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => {
            const list = (
              <ul className="flex flex-col">
                {/* Whole-row links with a hover surface, not a bordered table:
                    the row itself is the click target, the sidebar's idiom at
                    page width. The menu button overlays the row's reserved
                    right strip so it never nests inside the anchor. */}
                {group.conversations.map((conversation) => (
                  <li key={conversation.id} className="group/row relative">
                    <Link
                      to="/chat/$conversationId"
                      params={{ conversationId: conversation.id }}
                      className={cn(
                        focusRingClassName,
                        "hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 rounded-xl px-3 py-2.5 pr-11 text-sm transition-colors",
                      )}
                      title={describeActivity(conversation)}
                    >
                      <span className="flex min-w-0 flex-1 items-center">
                        <ConversationStatusTitle
                          generating={conversation.generating}
                          branched={!!conversation.branchedFrom}
                          scheduled={conversation.scheduled}
                          conversationId={conversation.id}
                          title={conversation.title}
                          registry={revealRegistry}
                        />
                      </span>
                      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                        {activityStamp(conversation)}
                      </span>
                    </Link>
                    <ConversationMenu
                      conversation={conversation}
                      actions={actions}
                      trigger={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Actions for ${conversation.title ?? "New chat"}`}
                          className="absolute top-1/2 right-1.5 -translate-y-1/2 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100 pointer-coarse:opacity-100"
                        />
                      }
                    >
                      <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                    </ConversationMenu>
                  </li>
                ))}
              </ul>
            );
            return group.label ? (
              <Section key={group.label} title={group.label}>
                {list}
              </Section>
            ) : (
              <Fragment key={group.label}>{list}</Fragment>
            );
          })}
          <InfiniteSentinel
            hasNext={pages.hasNextPage}
            isFetching={pages.isFetchingNextPage}
            onLoadMore={() => void pages.fetchNextPage()}
          />
        </div>
      )}
      {actions.renameDialog}
    </Page>
  );
}
