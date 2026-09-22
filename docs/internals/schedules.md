# Schedules

A schedule asks one prompt on a cadence: every fire starts a fresh conversation that answers
it on its own, with the schedule's model, collections, skills and search toggles. It never
reuses or extends an existing chat. Creation and editing happen from the schedules pages and
from chat through the generalized draft machinery ([agents](knowledge-and-agents.md)), with
the authoring depth in the `builtin:schedule-authoring` skill ([skills](skills.md)).

## Cadence and claiming

- The stored truth is three fields: `scheduleText` keeps the user's words ("every weekday at
  7am"), `cron` holds the 5-field expression, and `timezone` is the IANA name the cron is
  interpreted in (croner, via `cron.ts`, the only construction site). A one-time task is a
  single-fire cron plus `endAt` at the fire instant; there is no second cadence
  representation.
- `ScheduleService.tick` runs every 30 seconds (`forkScoped` in the app layer, so HMR disposal
  kills it). The claim is one transaction: due rows by database clock (`next_fire_at <=
  now()`), `FOR UPDATE SKIP LOCKED`, batch of 25, and each claimed row is rescheduled to its
  next fire after now **inside the claim**. That is the catch-up-once rule made structural:
  forty missed fires during downtime collapse into one fire and the cadence resumes from now;
  a one-shot whose next fire is past `endAt` comes out with `nextFireAt = null` and never
  fires again. Due-ness by database clock follows the blob-ledger rule: a JS Date that drifts
  ahead would make the scheduler quietly see nothing.
- The claim already rescheduled, so each fire is `Effect.forkDetach`ed and one slow fire
  cannot hold the tick; the `schedule_runs` row is the record of the attempt, not a reaper.

## Fires

- A fire is `ChatService.runScheduledTurn`, a sibling of `sendMessage` rather than a flag on
  it: the composer's first section (attachments, desktop, clarification answers) has no
  meaning for an unattended turn, and threading an origin flag would leak those invariants
  into the scheduler. The shared tail (createTurn, publish, startGeneration, title fork) is
  extracted; the scheduled call passes `conversationId: undefined` so `createTurn` writes the
  conversation row with `conversations.scheduleId` set.
- Run conversations are ordinary chats that the sidebar omits (`listConversations` filters
  `scheduleId is null`); `getConversation` deliberately does not filter, since the schedule
  detail page deep-links into them. Retry, edit and structured answers work there as normal;
  if nobody answers a clarification, the message lease reaps the turn. Branching a run chat
  produces a normal sidebar conversation (`scheduleId` null on the copy).
- Retained selections are never permissions: `modelId` and `agentId` have no FK. A missing
  model falls back to the user's default chat model at fire time (an unattended missed fire is
  worse than a different model answering); a deleted agent degrades the fire to a plain chat
  with the schedule's own collections, skills and toggles. Collections and skills are
  re-checked at fire and end the run as an `error` row when gone, because losing a selected
  collection failing the turn is the existing chat rule. A fire that never started (no
  available model) records `status: 'error'` with `conversationId: null`.
- Delete mid-run needs nothing new: the cascade removes conversation and messages, and the
  in-flight generation's next fenced write interrupts. Pause and resume touch only `paused`
  and `nextFireAt`; an in-flight fire is unaffected. "Run now" calls the same fire path
  without claiming, so the cadence is untouched and a run row is still written.
- Run status beyond "started" is derived by joining the run's conversation messages — no
  second status machine, no reaper.

## Drafts and sync

- Schedule drafts live in the same `conversation_drafts` store as agent drafts
  (`kind: 'schedule'`); the tools (`draft_schedule`, `read_schedule_draft`,
  `update_schedule_draft`) mirror the agent ones, including the alias map for near-miss field
  names, except that a `cron` change is validated against the draft's timezone at patch time:
  a bad cron stored now would fail at save with no model in the loop, so the tool rejects it
  with a correction instead. `list_agent_options` is shared, not forked — its kinds are
  exactly what a schedule needs.
- Save validates (cron parses, timezone is IANA, prompt non-blank, model accessible, agent
  owned, collections/skills readable), writes the schedule with its first `nextFireAt`
  computed from now, and stamps the target/saved receipt in one transaction; `schedule.changed`
  and `draft.changed` publish afterwards. Reload re-snapshots from the live schedule.
- Sync events: `schedule.changed { scheduleId }` and `schedule.run.changed { scheduleId,
  runId }`; the client invalidates `["schedules"]`, `["schedule", id]` and
  `["schedule-runs", id]`.
