# Notifications

Schedules are the one thing that runs while nobody watches, so they are what notifies. Each
schedule's `notify` says when: `always` after every run, `conditional` only when the answer
asked to, `off` never. A failed run notifies in both modes that notify. A stop, a skip
because the chat was busy, and an answer the person retried or edited say nothing: the
person was there, or the attempt is theirs.

## Exactly once, from the database

A run's end has three writers (the generation's own finalize, a startup failure, the
reaper) and a restart can cut the turn off before any callback runs. So nothing is sent from
those paths. `ScheduleSettlement.settle` claims ended runs by setting `schedule_runs.settled_at`
in one transaction with `SKIP LOCKED`, and only what it claimed is announced. The turn calls
it the moment its answer settles and the scheduler tick calls it every 30 seconds, so a run
the reaper ended is told within a tick. Runs from before settlement existed were marked
settled by the migration.

The same claim sets `conversations.unread`, the dot in the sidebar and on the Chats page.
The chat page clears it once the chat is on screen, not merely open in a background tab.

## Channels

`NotificationService.deliver` fans one `AppNotification` (title, body, path) out to every
channel the person has, each best effort and logged. A notification that cannot be
delivered never fails the run.

- Open tabs and the desktop app get it as the `notification` sync event, the one event that
  carries content rather than ids: it is immutable and capped well under the NOTIFY limit.
  A tab shows it through the Notification API unless its window is focused on that chat.
- In the desktop app that API produces native notifications without a permission prompt,
  and the hidden window keeps its page and its sync connection. A click asks the shell to
  bring the window forward through the optional `chrome.showWindow`, outside the Work
  protocol version, so an older shell still runs Work and only stays in the background.
- Every channel tags the notification with the run id, so several tabs show it once.
