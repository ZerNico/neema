# Compaction

How a chat keeps going past its model's context window. The stored transcript is never
touched: compaction only shapes what one attempt sends (`chat/server/compaction.ts`).

## When

- The budget is the window minus the answer's output, provider framing, the advertised tool
  schemas and, with web tools armed, room for their results (`computeBudget`). Compaction
  starts at whichever is later: 75% of that budget, or a fixed 24k tokens below it. A large
  window therefore runs nearly full, as Claude Code does on 1M models; on a small window the
  headroom would leave nothing, so the ratio wins. Every comparison uses the calibrated
  estimate, so the headroom absorbs estimator error.
- History is compacted before the first token streams; an answer's own completed rounds are
  compacted before a later model call. The newest user turn is never summarized.

## How

- **Clear before summarizing, inside an answer.** A chat answer over the trigger first
  replaces older tool results with a short stub, all at once so the cache breaks once. The
  newest three results, every receipt short enough that clearing saves nothing, and every
  call stay, so the model knows what it did and can read again. The stub never invites
  repeating a call, since a cleared call may have written, deleted or run something. Only
  if that is not enough is anything summarized. Clearing beat or matched LLM
  summaries at a fraction of the cost on agent runs (JetBrains, "The Complexity Trap", 2025).
  Research never clears: its workers cite those results.
- **The summary is a handoff in fixed sections** (goal, rules kept verbatim, decisions, files
  and references, dead ends, work done, open items, next step), after Claude Code's template.
  A chat summary may use about 3% of the window, between 2k and 8k tokens. Research keeps
  the fixed 2k its phase budgets reserve.
- **History summaries read the chat's cached prompt.** The summary request is the chat's own
  prompt (tools, system, retained history, with the same cache points) followed by a request
  naming the first message that stays verbatim. It repeats the chat's tool choice, reasoning
  setting and cache key, since Anthropic uncaches the tools and system on a changed
  `tool_choice`, and no call the model makes is run. Kept reasoning gets 16k output tokens
  of its own, so a model that counts it against output cannot spend the summary's
  allowance. When that prompt does not fit the window, or the call fails, the older
  flattened summary prompt runs instead. Both share one deadline (30 s scaled with the
  summary size, at most 90 s), since the answer's first token waits on them; a fallback
  with under 10 s left is skipped and turns are dropped instead. Titles, which
  share nothing with the chat's cache, use the admin's utility model; compaction never does.
- **Kept beside the summary, with its checkpoint:** the person's own messages from the
  summarized turns, verbatim and newest first within about 5% of the window, and every file
  those turns referred to with its attachment id. Without the list, a file attached before
  the cut could no longer be linked or opened by id. The visible activity shows only what
  the model wrote.
- **Roles.** The summary and the truncation notice are user-role application data with their
  own closing tags neutralized; see [prompt caching](prompt-caching.md).
- Hard truncation (dropping whole oldest turns) remains the fallback when no summary can be
  made, and overflow repair after a provider rejection is stricter still.
