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
A later reply in that chat sees the run's call in history but not the tool, and models
then concluded they had never called it. The trailing reminder (after history, so the
cached prefix is untouched) says such calls were runs and only a run can notify.

Offering `notify_user` and withholding `ask_user` changes the tool list, which leads the
cached prefix, so a switch between a run and a person's reply reads that prompt uncached
once. Runs are at least an hour apart, so a run's cache has usually expired anyway; the cost
is the first reply after it. Keeping one list for both would mean advertising tools that
the other kind of attempt must refuse.

## Channels

`NotificationService.deliver` fans one `AppNotification` (title, body, path) out to the
channels the person chose, each best effort and logged. A notification that cannot be
delivered never fails the run. Channels are per account and per kind of notification
(schedules are the only kind so far): push, on by default, and email, off until chosen and
offered only once an admin sets up a mail server. A schedule only says when.

Push means every device the person is signed in on, so it is one choice rather than one per
browser: open tabs, the desktop app and Web Push all follow it. What a single browser adds
is its permission, which the settings page asks for only while push is on and it is missing.

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
- A browser subscribes by itself on each visit once it has permission, and the
  subscription belongs to that sign-in's session row: signing out, or revoking the device
  under Devices, deletes it with the session, so there is no list of push devices to manage.
  An endpoint is one browser profile, so another sign-in in it takes the subscription over.
- Email goes through the SMTP server an admin set under Admin → Email, one row with the
  password under `KeyCipher`. The host is the admin's choice and may be an internal relay, so,
  like the SearXNG base URL, it is exempt from the public-address rule.
- Every email is HTML with a text part, from React Email templates rendered on the server.
  A schedule's email carries the start of the answer (`answerHtml`), cut between blocks, the
  one channel with room for it. That text is the model's, so raw HTML is escaped, images are
  dropped and only web and mail links stay links. Without `PUBLIC_URL` it has no links at all.
- Every channel tags the notification with the run id, so tabs and the service worker
  show it once between them. A tab always shows its own rather than leaving it to the
  worker: a subscription the browser holds may be one the server no longer has, and then
  nothing would appear. The worker always shows what it receives, since Chrome penalises
  a push that shows nothing.
