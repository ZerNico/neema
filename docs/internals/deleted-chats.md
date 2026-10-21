# Deleted chats

Delete asks nothing. The chat goes at once and a toast offers **Undo**, the way Archive does.
For that to be honest, a delete cannot remove anything yet: it sets
`conversations.deleted_at`, and the chat is purged for good by the sweep a few minutes later.
Until then it is gone for every reader and restorable by its owner alone.

## One predicate for "a chat its owner can reach"

- `ownedConversation(userId)` (`chat/server/owned-conversation.ts`) is owner and not deleted, and
  `ownedConversationById` adds the id. Every reader that serves a person goes through it, never
  a bare `conversations.user_id` match: the detail loader, sends and every other way a message
  gets in, branches, the queue, documents, drafts, memory provenance, file aliases, project
  chat lists, schedule targets and integrations. `listedBy` and `searchableBy` build on it, so
  every list and search inherits it. A new reader with a bare owner match shows deleted chats.
- Maintenance paths stay blind to the mark on purpose: the stream reaper, research
  finalization and the purge itself work by id. So does the generation fence, which checks
  ownership only. Its job is to prove a writer still owns its attempt, and an answer stopped by
  a delete must settle rather than be interrupted and stranded until its lease lapses.
- Background starts that are not a person check the mark directly: the queue dispatcher
  neither lists nor promotes a deleted chat, and a schedule's run history shows it as gone.
- Memory keeps its stored provenance through the grace, so Undo brings the source link back,
  but lists it only for a chat the reader can open.
- Serving a file by id still follows the attachment's own owner. The bytes are the deleter's
  own, and they go at the purge.

## Mark first, then stop

`ChatService.deleteConversation` marks the chat, then stops every answer still streaming the
way Stop does (research cancelled, the fiber aborted and awaited). The order is the point.
Every way an answer starts (send, retry, edit, a structured answer, queue promotion, a schedule
fire) locks the chat row through the predicate, so once the mark commits nothing new begins,
and the list of live answers read after it is complete. Stopping first would leave a window
where a send from another tab starts an answer nobody stops.

An answer's row commits a few steps before its fiber registers with the engine, and a delete
in that gap finds nothing to stop. `StreamEngine.stopGeneration` then leaves an early stop the
fiber claims as it registers, so it stops before any model call. That stop lives in the engine,
not on the chat, so an Undo landing first cannot clear it.

The delete waits up to ten seconds for each answer to settle as stopped. One slower than that
is still winding down when Undo brings the chat back, and settles as stopped, never resuming.
A failure while stopping is logged and still returns the mark, since the chat is deleted either
way. Delete is idempotent: a repeat returns the same mark and stops again, so a retry finishes
what a failed one left.

## Grace, the toast and the purge

- `DELETED_CHAT_GRACE_SECONDS` (two minutes) is much longer than the eight-second toast, which
  also pauses on hover, so the sweep practically never races Undo. "Empty now" in Settings ›
  Storage can: it purges the person's deleted chats at once, to free their files, and gives up
  their Undo, perhaps from another tab while a toast is still up. Either way a losing Undo has
  `restoreConversation` return false, and the toast says the chat is already gone.
- The delete returns its mark (`deleteMark`: `deleted_at` in UTC to the microsecond), and Undo
  must name it. An Undo held from an earlier delete therefore cannot reverse a later one.
- The purge is the [temporary-chat](temporary-chats.md) sweep, generalised:
  `ChatService.sweepExpired` every `ConversationSweepInterval` (a minute) purges deleted chats
  past their grace and expired temporary chats alike, through `deleteLocked`. "Empty now"
  (`ChatService.emptyDeleted`) goes through the same `deleteLocked`, a hundred chats a request. Research is
  settled, attachments and queued files are released into `blob_cleanup_intents`, all under the
  row lock with the condition checked again, so an Undo landing after the listing wins.
  Grace is judged by the database clock, like every other expiry here.
- A deleted chat is purged on its grace alone. The temporary-chat expiry ignores deleted chats,
  or an idle temporary chat would be purged under its own Undo. A streaming row inside its
  lease does not hold the purge back either: the delete stopped it, and an answer still dying
  when "Empty now" lands finds its row gone, its research settled under the purge's lock.

## Events and the desktop workspace

- Delete publishes `conversation.deleted`, Undo `conversation.updated`, the purge
  `conversation.purged`. Every tab refreshes its lists on each, so another tab drops the chat
  and gets it back.
- A work chat's workspace, grants and folders live on the user's machine, keyed by the chat's
  id, and must outlive the delete or Undo would bring back a work chat without its folder.
  Undo is only offered in the deleting window's toast, so that window discards them once the
  delete has landed and the toast went without its Undo. `conversation.purged` discards them
  too, for a window that closed first. A machine with no window open at either moment keeps a
  stray directory.

## The client

- Delete and archive hold the row out of every cached list before the server answers
  (`chat/client/held-rows.ts`), and a list fetched before the server has the outcome is
  corrected as it arrives, whatever asked for it: another action's refresh, a sync event. Undo
  shows the row again where it sat, in the lists as they are by then, so a second delete or any
  newer change survives it.
- Actions on one chat reach the server in the order they were asked for (`inLane`), so a delete
  made while an Undo is still on its way lands after it.
- Deleting the open chat goes home. Undo reopens it once the server has it back, and only if
  the reader is still on the home page the delete left them on.

## Schedules

A schedule that keeps one chat (`chatMode: "same"`) and fires into it during the grace finds
no chat, starts a fresh one and adopts it, as it would after a purge. The adoption replaces the
chat that fire found, whether or not an Undo has brought it back meanwhile, and never a chat an
edit picked since. Undo restores the old chat but does not point the schedule back at it.
