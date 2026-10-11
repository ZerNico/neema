# Archived chats

An archived chat is an ordinary conversation with `conversations.archived_at` set by its owner.
It leaves the sidebar, the Chats page's main list and project lists; search still finds it,
marked **Archived**, and a page below Chats (`/chats/archived`) lists it with the usual row menu. Settings → Archived chats only counts them, links there and holds Archive
all, so the list lives in one place. It keeps everything else: memory, documents, its project,
its schedule.

## Two predicates, not one

- `ChatRepo.listedBy` is "chats a list may show": owned and not [deleted](deleted-chats.md)
  (`ownedConversation`), not temporary, not archived. Every list
  uses it (see [temporary chats](temporary-chats.md) for the full set). The project chat list
  has its own where-clause in `projects/server/service.ts` and repeats the archived condition.
- `ChatRepo.searchableBy` is "chats search may find": owned and not deleted, not temporary,
  archived allowed.
  The title query, `recentMatches` and `indexedMatches` use it, and each hit carries
  `archived`. Search is how an archived chat is found again, which is why it is ChatGPT's rule
  too.
- A new list goes through `listedBy`; a new search path through `searchableBy`. Mixing them up
  either clutters the sidebar or makes archived chats unfindable.

## What brings a chat back

- Writing in it: the owner's send, structured answer, queue promotion, steer, retry and edit all
  clear `archived_at` in the same transaction that records the turn (`createTurn`,
  `promoteNextQueuedTurn`, `resetMessageForRetry`, `createAssistantForEdit`).
- **Not** a schedule's fire. `createTurn` skips the clear when it carries a `scheduleRunId`:
  nobody wrote, and a chat a schedule keeps using would otherwise reappear after every fire,
  undoing the archive.
- A branch starts unarchived: the insert names its fields and leaves `archived_at` out.

## Temporary chats

A temporary chat is never archived (`conversations_archived_not_temporary`). Nothing lists it,
so there is nothing to archive it from, and Archive all skips it through `listedBy`.

## Events

Archive, unarchive and Archive all publish `conversation.updated`; every tab refreshes its chat
lists and details by key prefix. Archive acts at once and offers Undo through the same toast as
delete (`src/ui/undo-toast.ts`), and an archived chat that is open stays open. Archive all publishes one event for the whole batch, since the
refresh does not depend on which chat it names.
