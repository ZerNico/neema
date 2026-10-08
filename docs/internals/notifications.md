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

## The answer decides

A `conditional` schedule offers its fire's own attempt `notify_user` (the `notify` family),
found by the run row naming that message and generation, so a retry, edit, resume or branch
is never offered it. The call does not send anything: it keeps the text on the run row, one
call per answer, and settlement sends it once the answer has ended. A stopped or replaced
answer therefore sends nothing, and the tool row records only the text that was kept.

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
- Browsers that are closed, and phones with neema on the Home Screen, get Web Push.
  Encryption (RFC 8291) and the server's signed claim (VAPID, RFC 8292) are written on
  `node:crypto` and tested against the RFC's own example, rather than taken from a
  library that would send through its own HTTP client: a subscription's endpoint is a URL
  the browser chose, so it passes `resolvePublicHttpUrl` when saved and again on every
  send, which goes through `fetchPinned`. A 404 or 410 deletes the subscription.
- The VAPID key pair is made on first need, one row, private half under `KeyCipher`.
  Replacing it orphans every subscription, so nothing rotates it.
- An endpoint belongs to one browser profile. Subscribing it under another account moves
  it there, and signing out unsubscribes this browser first, so a shared computer stops
  receiving the last person's notifications.
- Email goes through the SMTP server an admin set under Admin → Email, one row with the
  password under `KeyCipher`, to people who turned it on in their notification settings
  (off until they do). The host is the admin's choice and may be an internal relay, so,
  like the SearXNG base URL, it is exempt from the public-address rule.
- Channels are the person's, chosen once in settings; a schedule only says when.
- Every channel tags the notification with the run id, so several tabs show it once. A tab
  in a browser with a push subscription shows nothing itself and leaves it to the service
  worker, which always shows what it receives: Chrome penalises a push that shows nothing.
