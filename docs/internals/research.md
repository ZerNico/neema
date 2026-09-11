# Deep research

Deep research is a persisted request mode of an ordinary conversation, not a chat setting or a separate feature. The one fact that shapes everything else: the main assistant (`conversation-research.ts`) owns the conversation, clarification, briefing and the sole final synthesis, while `research/runner.ts` and `research/execution.ts` only investigate a self-contained brief and never see raw history, memory or the final-text sink.

## Mode and run identity

- Research is a persisted request mode; only validated structured answers inherit it server-side, ordinary text does not. Retry/edit use the target's saved mode. Retry installs a fresh `researchRunId` even when the message ID is reused.
- Research writes hold the conversation lock and validate current run/owner/lease. Stop, local cancellation, SSE events and client hook identity must all carry the expected run ID. Expired research is terminalized, never auto-resumed.
- Research tails ordered DB chunks every second, unlike ordinary chat's local live tail. Keep the active SSE subscription through `done` even if a sync refresh sees the terminal row first, or the sticky overlay can strand undisplayed questions and stale status.

## Ownership split

- `conversation-research.ts` owns clarification, the memory-aware brief (the `planning` phase) and the sole final synthesis. `research/runner.ts` receives only that brief plus a separately built investigation execution object — no raw conversation history, memory snapshot or final-text sink. There is no polished investigator answer that synthesis later rewrites.
- Selecting research forces investigation; briefing prose cannot opt out. If the first coordinator returns no assignments (including an immediate `finish_research`), the brief itself is admitted as one task through the normal budget/worker path — merely calling the coordinator does not guarantee investigation, since simple questions made it finish before any report existed.
- Task-relevant remembered constraints can enter the brief through model selection; that is context isolation, not a guarantee against semantic disclosure by the briefing model.
- `research/execution.ts` keeps one budget, lease/fence, deadline and accounting stream all the way through the final assistant answer.

## Clarification and synthesis

- Clarification is internal: discard its prose, emit only validated `ask_user` activities. Only main-assistant synthesis writes outer research prose — a model ignoring stage policy must not leak an uncited answer before investigation.
- Synthesis can prepare or revise an [agent draft](knowledge-and-agents.md#conversational-drafts) through four tool-capable rounds followed by one tool-free answer. These are continuations of the same final answer and run, not fresh research: each call uses the existing budget, deadline, fence, accounting and citation-aware text sink. Clarification stays ask-only; coordinator/workers/reporting receive neither the draft toolkit nor private settings. Main-stage prompts refresh current draft data and budget the actual toolkit before dispatch.
- Context-overflow repair may retry a synthesis call only before that call emits answer text; after output it ends partial, never appends a restarted answer. A late failure anywhere in the bounded continuation preserves earlier prose and committed draft changes, with no duplicated answer.
- Synthesis is prompted to cite sparingly: one marker on a claim worth verifying, the strongest source, at most two per sentence, none on common knowledge or summary lines. The chip rendering is identical either way, so the prompt is the only lever against a citation on every clause.

## Transcript and panels

- The research row is one line: live phase plus current search/read while exploring, then `Researched N sources`. It settles the moment synthesis starts, not when the message completes — the answer streams below it with the ordinary "Thinking…" state, so there is no "writing" state for a research turn. It opens the run's activity panel (`research-panel.tsx`, searches/reads grouped by task) under its own panel id.
- The detail panel snapshots its body at open; `ResearchPanelOwner` refreshes body/subtitle in a commit effect from the final persisted/live display. Selection is message + run ID, independent of bubble mounts. Identity-checked refresh cannot reopen a closed panel or replace Sources; retry closes the superseded run. There is no module-level message cache or render-time publication.
- The sources panel lists sources without an extraction badge: whether a page was read or only snippeted is model-facing (`evidenceManifest`), not reader-facing. Plan and worker reports never render. `progress.limitations` is written for synthesis and the run record only; the panel reduces it to one plain `coverageNote` and says nothing for routine cases (a provider hiccup on one of thirty calls, a report at its output cap, incomplete usage accounting). A failed task reads "Incomplete", not "Failed" — a failed read is never a user-facing limitation, the worker prompt just routes around it. An `awaiting_answer` run renders nothing; its question card follows and the answered run continues in the next message.

## Citations

- `validateResearchCitations` accepts plain `[N]` for a registered source and normalises it to `[^N]`, because models write both forms and the chip renderer keys off the footnote form. Unregistered footnote handles become `[unverified source]`; bare bracketed numbers without a registered source stay plain text.

## Search and outage detection

- SearXNG returns HTTP 200 with `results: []` plus `unresponsive_engines` for both partial and total failure. The backend requests the enabled general engines from `/config` (respecting time-range support) and only fails when every requested engine is unresponsive. Missing config or a query bang selector leaves participation unknown, not evidence of a total outage; HTTP/transport failures still fail outright.
- The budget counts consecutive failed backend queries across all workers (`observeSearch`), once per actual backend completion — never per tool batch, waiter, cache hit, cancellation or refusal. At `searchOutageThreshold` it latches `searchUnavailable`, which ends exploration and dispatch and adds one plain limitation: one failed search is the worker rephrasing, a run of them is the backend down.

## Prompt mechanics

- Stage evidence stays assistant-role data, followed by an application-authored user-role stage request. Never end coordinator, report or synthesis prompts on the evidence block — models that disallow assistant prefill reject it. The request lives in protected trailing context so history/active-round compaction and overflow repair cannot drop it.
- Per-call provider timeouts key off stream inactivity (`providerStallMs`), not elapsed time: a worker's searches and reads run inside its own model stream and report progress, so a wall-clock cap would fail productive rounds. The run deadline still bounds every call. A synthesis that already emitted validated lines ends `partial`, never `error` — the reader can see it.
- Every exploring turn ends on a user-role soft budget line (`prompts.budgetNotice`, from `budget.remaining()`/`headroom`). It stays last so the prompt prefix keeps its cache, and rides trailing/protected context so compaction budgets it.

## Budgets and caps

- The admin `researchMaxSearchQueries` setting (default 80, range 12–120) caps individual queries across all workers, not tool calls or ordinary chat. It is resolved once when research starts; admission and soft-budget headroom use that same captured value, so admin edits apply only to subsequent runs/retries. Stage prompts stop on evidence-based completion and consequential gaps, not a source-count target — the budget is a ceiling, never a goal.
- Per-phase output caps come from the model's configured `contextLength` (`researchOutputCaps`), with `RESEARCH_LIMITS.*Output` only as ceilings. Task admission reserves an ordinary worker call plus all pending reports and synthesis at their own caps, not a shared synthesis reserve. Full citation-validated task reports are retained within that generation cap; later stages fit them through evidence compaction rather than a second character cutoff. A report finish reason of `length` signals actual output-limit truncation and adds a limitation while preserving the available report.
- `research/budget.ts` admits actual model calls and batched web targets before execution. The first refused web admission latches `webRefused`, so further rounds and dispatch stop instead of spending model calls on tools that must refuse. Reaching a ceiling is the design, not a limitation: it is reported to synthesis as an execution bound so the answer can disclose it, but stays out of the user-facing limitation list, which is reserved for coverage that actually failed.
- All workers share one web semaphore, source indexer and URL authority. Worker prose grants no URL authority and never becomes outer assistant text. Child tool/compaction activity nests under the run's root activity rather than being sorted independently into prose.

## Evidence projections and progress

- Main-assistant history and investigation evidence are separate projections. The main history projection retains its start index, injections and checkpoint, including hard truncation and overflow repair; later stages never resurrect dropped turns. Investigation hands back its current evidence projection only, never reconstructing discarded raw reports. Worker manifests are task-local; inherited sources remain registered but do not become this run's collected evidence merely by being in history.
- `projectResearchProgress` is the explicit durable display boundary for live, terminal and branch snapshots. The plan stays run-local and reports stay in task columns, never in root tool/SSE progress. Planning text deltas do not publish progress; unchanged snapshots are suppressed. Research compaction summary bodies stay server-side for checkpoints, never in emitted compaction chunks or public conversation-detail/branch events (ordinary chat compaction summaries remain displayable).

## Usage and ledger

- Research calls checkpoint observed usage; finalization appends one idempotent aggregate chat ledger row keyed by run ID. Compaction uses its own call ID for a separate ledger row, excluded from the chat aggregate. Missing usage means incomplete/unknown cost, not zero. Branch copies terminal display snapshots with fresh IDs only, never calls or ledger entries.
