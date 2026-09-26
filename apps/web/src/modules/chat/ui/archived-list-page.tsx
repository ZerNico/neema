import { Archive02Icon, MoreHorizontalIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { archivedConversationsQuery } from "../client/queries.ts";
import { ConversationMenu, useConversationActions } from "./conversation-actions.tsx";
import { EmptyState, Page } from "~/ui/page-shell.tsx";
import { Button } from "~/ui/primitives/button";
import { SearchInput } from "~/ui/search-input.tsx";
import { focusRingClassName } from "~/ui/focus-ring.ts";
import { useDebounced } from "~/ui/use-debounced.ts";
import { cn } from "~/ui/utils";

const archivedDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** Archived chats, a page below Chats: the same rows, their own list. */
export function ArchivedChatsListPage() {
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim(), 250);
  // Archived chats are few and all fetched; the search box filters their titles here.
  const archivedList = useSuspenseQuery(archivedConversationsQuery);
  const actions = useConversationActions();
  const archivedRows = useMemo(() => {
    const needle = query.toLowerCase();
    return (archivedList.data ?? []).filter(
      (chat) => !needle || (chat.title ?? "").toLowerCase().includes(needle),
    );
  }, [archivedList.data, query]);

  return (
    <Page title="Archived chats" backTo="/chats" backLabel="Chats">
      <SearchInput
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search archived chats…"
        aria-label="Search archived chats"
      />
      {archivedRows.length === 0 ? (
        query ? (
          <EmptyState
            icon={Search01Icon}
            title="No archived chats match"
            description={`No titles match “${query}”.`}
          />
        ) : (
          <EmptyState
            icon={Archive02Icon}
            title="No archived chats"
            description="Archive a chat from its menu to keep it out of your sidebar."
          />
        )
      ) : (
        <ul className="flex flex-col">
          {archivedRows.map((chat) => (
            <li key={chat.id} className="group/row relative">
              <Link
                to="/chat/$conversationId"
                params={{ conversationId: chat.id }}
                className={cn(
                  focusRingClassName,
                  "hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 rounded-xl px-3 py-2.5 pr-11 text-sm transition-colors",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{chat.title ?? "New chat"}</span>
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                  Archived {archivedDate.format(new Date(chat.archivedAt))}
                </span>
              </Link>
              <ConversationMenu
                conversation={{ id: chat.id, title: chat.title, archived: true }}
                actions={actions}
                trigger={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Actions for ${chat.title ?? "New chat"}`}
                    className="absolute top-1/2 right-1.5 -translate-y-1/2 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100 pointer-coarse:opacity-100"
                  />
                }
              >
                <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
              </ConversationMenu>
            </li>
          ))}
        </ul>
      )}
      {actions.renameDialog}
    </Page>
  );
}
