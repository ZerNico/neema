# Temporary chats

A temporary chat is an ordinary conversation with `conversations.temporary` set when it was
created. Everything else about it (agents, knowledge, tools, research, documents) is unchanged.
Three things differ: nothing lists it, it has no memory, and it is deleted a day after its last
activity. **Keep** clears the flag. Nothing sets the flag after creation, and that is the rule
the rest of this page depends on.

## One flag on the row, read per attempt

- The flag lives on the conversation, not in the attempt's generation config. Every way a
  message gets in (send, retry, edit, structured answer, queue promotion, steer) reads it
  from the row when the generation starts, in `streaming.ts`. Keep therefore takes effect
  on the next attempt, and no path has to carry the flag.
- Memory is gated where it is offered: `prepareConversationContext` skips both the
  referenceable snapshot and `save_memory`. A write-boundary check is not needed, because a
  chat can only move from temporary to kept, never back. If the row is gone when the attempt
  starts, the chat is treated as temporary.
- Research brief preparation uses the host turn's memory tools, so it inherits the gate.

## Kept out of every list

- `ChatRepo.listedBy` is the predicate for "chats a list may show". Every place chats are
  listed has to use it: `listConversations` (the sidebar, `/chats`, the palette's recent
  chats, the schedule chat picker), plus the title query, `recentMatches` and `indexedMatches`
  behind `searchConversations`. Adding a new list without it leaks temporary chats.
- A schedule refuses a temporary chat as its target (`validate.ts`). The chat would be swept
  while the schedule still pointed at it.
- A branch copies the flag: a copy of a temporary chat must not outlive it in the sidebar.
  Its day starts when the branch is created.
- A work chat cannot be temporary. Its grants and folders are keyed by its id on the user's
  machine, and deleting it silently would strand them.

## Lifetime

- There is no `expiresAt` column. Expiry is `coalesce(last_message_at, created_at)` plus
  `TEMPORARY_CHAT_HOURS`, compared against the database clock inside the sweep's SQL (see the
  blob-cleanup note in `AGENTS.md` for why a JS clock is not used). Keep therefore has only
  one column to clear, and a new message pushes expiry back without any extra write.
- `ChatService.sweepTemporary` runs every `TemporarySweepInterval`. It lists candidates, then
  deletes each one in `deleteExpiredTemporary`, which checks the expiry condition again under
  the row lock. A Keep or a new message that lands between listing and deletion wins. A chat
  with an answer still inside its lease is skipped until the next pass.
- Deletion uses the same transaction body as a person's own delete (`deleteLocked`): research
  is settled, attachments are released into `blob_cleanup_intents`, and `conversation.deleted`
  reaches every open tab.
- `usage_events` keeps its rows. The ledger is append-only and has no foreign key to
  conversations, for any deletion.
