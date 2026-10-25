# Schedules

A schedule asks one prompt on a cadence, with the schedule's model, collections, skills and
search toggles. `chatMode` decides where: `new` starts a fresh chat each fire; `same` keeps
answering in one chat, `chatId`, which is either picked in the editor or created and adopted
by the first fire. Creation and editing happen from the schedules pages and
from chat through the generalized draft machinery ([agents](knowledge-and-agents.md)), with
the authoring depth in the `builtin:schedule-authoring` skill ([skills](skills.md)).

## Cadence and claiming

- The stored truth is three fields: `scheduleText` keeps the user's words ("every weekday at
  7am"), `cron` holds the 5-field expression, and `timezone` is the IANA name the cron is
  interpreted in (croner, via `cron.ts`, the only construction site). A one-time task is a
  single-fire cron plus `endAt` at the fire instant; there is no second cadence
  representation. The editor's frequency picker is a view of that cron (`cadence.ts`), so
  it offers only what cron repeats exactly: hour and month steps that divide evenly, never
  every N days, weeks or years. A cron it cannot read is shown as set in chat, not edited.
- `validateCron` is the one gate for every writer (save, preview, the model's draft tools):
  exactly five fields, since croner would take a seconds field, and at most one fire an
  hour (`MIN_FIRE_GAP_MS`). Each fire is a conversation and a model call.
- `ScheduleService.tick` runs every 30 seconds (`forkScoped` in the app layer, so HMR disposal
  kills it). The claim is one transaction: due rows by database clock (`next_fire_at <=
  now()`), `FOR UPDATE SKIP LOCKED`, batch of 25, and each claimed row is rescheduled to its
  next fire after that same database timestamp **inside the claim**. That is the catch-up-once rule made structural:
  forty missed fires during downtime collapse into one fire and the cadence resumes from now;
  a one-shot whose next fire is past `endAt` comes out with `nextFireAt = null` and never
  fires again. Due-ness by database clock follows the blob-ledger rule: a JS Date that drifts
  ahead would make the scheduler quietly see nothing.
- The claim reschedules and inserts a `pending` `schedule_runs` row in the same transaction,
  before the fire is detached. One slow fire cannot hold the tick. Manual Run now inserts its
  pending row before detaching, without changing cadence. A detached fire renews the pending
  row's database-clock lease while it works; a lapsed, unbound attempt is reconciled to
  `error`, never replayed, because replay could duplicate a turn whose outcome is uncertain.
  This also protects slow pre-turn checks and busy-chat waits across a runtime replacement.
  Revoked schedule permission keeps the row but records a `skipped` fire without a chat.
  Account approval and active bans are checked before credentials are resolved, then again
  under the account lock in turn acceptance. Ineligible accounts also skip the fire.
  Future fires resume on regrant, not missed one-shots. See [feature access](feature-policy.md).

## Fires

- A fire is `ChatService.runScheduledTurn`, a sibling of `sendMessage` rather than a flag on
  it: the composer's first section (attachments, desktop, clarification answers) has no
  meaning for an unattended turn, and threading an origin flag would leak those invariants
  into the scheduler. The shared tail (createTurn, publish, startGeneration, title fork) is
  extracted. The scheduled call passes `target: { kind: "new" }`, so `createTurn` writes the
  conversation row with `conversations.scheduleId` set, or `{ kind: "existing" }` in `same` mode.
- Run conversations are ordinary sidebar chats, marked with a calendar
  (`listConversations.scheduled`: created by a schedule, or a schedule's `chatId`), because a
  run hidden on the schedule page is a run nobody finds. `conversations.scheduleId` means
  "a fire created this"; a picked chat keeps it null and links back through `chatId`
  instead. Retry, edit and structured answers work there as normal; if nobody answers a
  clarification, the message lease reaps the turn. Branching a run chat produces a normal
  conversation (`scheduleId` null on the copy).
- A fire's own attempt is unattended, found by its run row naming that message and
  generation, so it is never offered `ask_user`: nobody would answer, and the question
  would be the whole answer. A person's retry or edit in the run chat is theirs and is.
- In `same` mode an agent cannot change after a
  chat's creation, so an existing chat keeps its own agent and the schedule's `agentId` only
  applies to chats a fire creates. Work chats run their tools in the desktop app, which an
  unattended fire never has, so they are refused at save (`checkScheduleResources`) and
  again by `runScheduledTurn` itself. A chat that is still answering is waited
  on, every 15 seconds for up to five minutes, then the run is recorded as skipped: the
  owner may be mid-conversation in it. A picked chat that was [deleted](deleted-chats.md) is not
  found, so the fire starts a new chat and adopts it (`adoptChat`). It adopts only while the
  schedule still holds the chat that fire found gone, or none, the purge having cleared it by
  its FK (`on delete set null`). An edit mid-fire wins, and Undo of the delete brings back the
  old chat without moving the schedule back to it.
- Retained selections are never permissions: `modelId` and `agentId` have no FK. A missing
  model falls back to the user's default chat model at fire time (an unattended missed fire is
  worse than a different model answering); only a genuinely deleted agent degrades the fire
  to a plain chat with the schedule's own collections, skills and toggles. A retained agent
  made inaccessible by policy fails rather than changing the scheduled job. Collections,
  skills and granted integration connections are re-checked at fire and end the run as an
  `error` row when gone, because losing a selected collection failing the turn is the
  existing chat rule. A fire that never started (no
  available model) records `status: 'error'` with `conversationId: null`.
- Nobody is present to approve during a fire, so integrations are consented to up front:
  `schedule_integration_grants` caps each account at read or read and write, and a fire is offered
  exactly those, refusing rather than asking for anything more. Contacting people (sending
  mail, inviting to events) needs an allowance listing the exact addresses, at most a few
  calls per run. Only the person writes grants, in the editor or the draft panel; the model's
  draft tools cannot name them. See [integrations](integrations.md#schedules-decide-in-advance).
- Deleting a schedule keeps its chats: `conversations.schedule_id` is `on delete set null`,
  since they sit in the sidebar like any other chat. The run history goes with the schedule;
  an in-flight fire finishes in its chat. Pause and resume touch only `paused`
  and `nextFireAt`; an in-flight fire is unaffected. "Run now" calls the same fire path
  without claiming, so the cadence is untouched and a run row is still written.
- `createTurn` locks the pending attempt and binds its conversation, its assistant message
  and that message's generation in the same transaction that writes the user and assistant
  messages. A stale or settled attempt cannot create a turn. Typed failures, defects and
  interruption settle an unbound attempt; a bound attempt remains `started`, and the
  message-generation lease handles an orphaned streaming answer.
- A run is over when it never started, or when its message stops streaming or stops being
  the fire's attempt (a person retried or edited it). `settleRuns` claims such runs once,
  setting `settled_at` under `FOR UPDATE SKIP LOCKED`, and marks the chat `unread` in the
  same transaction when the fire's own answer ended. The turn's `onSettled` calls it at
  once, and the tick calls it too, because the reaper and a restart never reach a callback.
  Only then does the owner hear of it; see [notifications](notifications.md).

## Drafts and sync

- Schedule drafts live in the same `conversation_drafts` store as agent drafts
  (`kind: 'schedule'`); the tools (`draft_schedule`, `read_schedule_draft`,
  `list_schedule_options`, `update_schedule_draft`) mirror the agent ones, including the alias
  map for near-miss field names, except that a `cron` change is validated against the draft's
  timezone at patch time: a bad cron stored now would fail at save with no model in the loop,
  so the tool rejects it with a correction instead. Each kind has its own options tool over one
  listing (`drafts/server/resource-options.ts`), because the two families are offered and
  loaded separately: a person may draft schedules without being allowed to author agents.
- A draft holds every setting, as working text that may still be blank. No key means "keep
  what is saved": a missing one was read two ways before, and a draft could switch a `same`
  schedule back to a new chat each fire.
- Save validates (cron parses, timezone is IANA, prompt non-blank, model accessible, agent
  owned, collections/skills readable), writes the schedule with its first `nextFireAt`
  computed from now, and stamps the target/saved receipt in one transaction; `schedule.changed`
  and `draft.changed` publish afterwards. Reload re-snapshots from the live schedule.
- `schedules.config_revision` moves with every settings write, a fire adopting its chat
  included, and never with a claim, pause or resume. Every settings save names the revision
  its values came from, the detail page's form as much as a draft, and the repository writes
  only over that one, else `ScheduleChanged` asks for a reload: without it an editor opened
  before a first fire wrote its null `chatId` back, and the next fire made yet another chat.
  `updated_at` cannot serve, since every claim moves it.
- Sync events: `schedule.changed { scheduleId }` and `schedule.run.changed { scheduleId,
  runId }`; the client invalidates `["schedules"]`, `["schedule", id]` and
  `["schedule-runs", id]`.
