import { getLocale } from "~/paraglide/runtime.js";
import { m } from "~/paraglide/messages.js";
import { Archive02Icon, MoreHorizontalIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { archivedConversationsQuery } from "../client/queries.ts";
import { ConversationMenu } from "./conversation-actions.tsx";
import { useConversationActions } from "./use-conversation-actions.tsx";
import { EmptyState, Page } from "~/ui/page-shell.tsx";
import { Button } from "~/ui/primitives/button";
import { SearchInput } from "~/ui/search-input.tsx";
import { focusRingClassName } from "~/ui/focus-ring.ts";
import { useDebounced } from "~/ui/use-debounced.ts";
import { cn } from "~/ui/utils";

/** Archived chats, a page below Chats: the same rows, their own list. */
export function ArchivedChatsListPage() {
  const [search, setSearch] = useState("");
  const archivedDate = new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium" });
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
    <Page title={m.chat_archived_title()} backTo="/chats" backLabel={m.chat_archived_back()}>
      <SearchInput
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={m.chat_archived_search()}
        aria-label={m.chat_archived_search_label()}
      />
      {archivedRows.length === 0 ? (
        query ? (
          <EmptyState
            icon={Search01Icon}
            title={m.chat_archived_no_match()}
            description={m.chat_list_no_titles_match({ query })}
          />
        ) : (
          <EmptyState
            icon={Archive02Icon}
            title={m.chat_archived_empty()}
            description={m.chat_archived_empty_description()}
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
                <span className="min-w-0 flex-1 truncate">
                  {chat.title ?? m.chat_title_new_chat()}
                </span>
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {m.chat_archived_on({ date: archivedDate.format(new Date(chat.archivedAt)) })}
                </span>
              </Link>
              <ConversationMenu
                conversation={{ id: chat.id, title: chat.title, archived: true }}
                actions={actions}
                trigger={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={m.chat_list_row_actions({
                      title: chat.title ?? m.chat_title_new_chat(),
                    })}
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
