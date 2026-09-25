# Search

The Cmd/Ctrl+K palette (`modules/search/ui/command-palette.tsx`) searches chats, projects,
agents, knowledge collections, skills, schedules and app pages, and runs actions. `>` narrows it to
actions.

## Sources

- A kind of thing becomes searchable by writing a `SearchSource` hook in its own module and
  calling it in `useSearchGroups` (`modules/search/sources.ts`). That call list is the registry.
  Sources are hooks because most of them read TanStack Query; they are called explicitly, in
  display order, because hooks cannot run in a loop. `>` switches the others off through their
  `active` flag instead of skipping them.
- Each source owns its matching, its cap and its permission check. A source must never return
  anything its own pages would not show: gate on `capabilitiesQuery` and the session role, and
  keep server queries scoped to the signed-in user as the module's other reads are.
- Kinds whose whole list the browser already loads (projects, agents, collections, skills, schedules) use
  `listSource` and filter locally. Only chats search on the server, and never find a
  [temporary chat](temporary-chats.md).
- Results stay grouped by source and are never merged into one ranking: scores from different
  sources, local or remote, are not comparable.
- A result's excerpt is plain text plus highlight ranges (`Snippet`, `modules/search/text.ts`),
  never backend-generated HTML, so any backend can fill it.

## Chat search in Postgres

- Message text is matched through an **expression index**, `messages_search_idx` on
  `to_tsvector('app_search', content)`, not a stored column: every full-row read of `messages`
  would otherwise carry the vector. A query must repeat that expression exactly
  (`messageSearchVector` in `ChatRepo`) or Postgres scans every message.
- `app_search` is `simple` plus `unaccent`. `simple` stems no language, so every language is
  treated alike, at the cost of stemming ("läuft" does not find "laufen"). It is a named
  configuration because an index may only use immutable expressions and `unaccent()` is not
  one. Terms become word prefixes (`koffer:*`), which also covers German compounds.
- Scripts without spaces (Chinese, Japanese, Thai) form one token per run, so word search
  barely works for them. Titles carry a trigram index (`conversations_title_trgm_idx`), which
  matches substrings in any script; message text does not, because trigrams cost far more on
  long text.
- Results are title matches first, then chats by recency, each with its newest matching
  message. There is no ranking. Messages are found in two steps: the user's 40 most recent chats,
  each checked back through its latest 200 messages, and only if that fills less than a page, the
  index across the whole history. Collecting every match of a frequent term to show eight was
  the slow part (seconds at a million messages); the window answers it in milliseconds, and a
  term too rare to fill it is one the index answers quickly. The cost of the window: a frequent
  term matching only further back in a long, recent chat can lose to hits found in it.
- The index step raises `work_mem` for its transaction. Below it, a broad term's bitmap turns
  lossy and Postgres rechecks whole pages by recomputing each message's vector, because the
  index is an expression with no stored column to reread: 10 s instead of 0.4 s at a million
  messages. `ts_headline` re-reads the whole text too, so it runs only for the rows returned.
- Only persisted `messages.content` is searched: an answer is written there when it finishes,
  so in-flight text and queue entries are never found. Branches are separate chats and are
  found separately.

## Another backend

The swap point is a source, not a generic backend layer: a Meilisearch or Elasticsearch chats
source would replace `useChatSearch`'s server call and leave the palette and the other sources
alone. Such an index is a copy, so it needs what Postgres gives for free: a durable outbox so
every create, edit, delete and branch reaches it (like `blob_cleanup_intents`), a rebuild path,
and per-document permissions, or results leak and deleted chats linger.
