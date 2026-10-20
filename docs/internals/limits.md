# Usage limits

Admins cap what people spend: cost in USD or a number of answers, per day, week or month,
over every model or chosen ones. Rules live in `usage_limits`; `modules/limits/` holds the
rules, the check and the editors.

## Whose rules hold

- Everyone's rules (no group) are the baseline for every person but admins.
- A group's rule replaces everyone's for the same limit, meaning the same measure, period and
  models (`limitKey`). It may raise or lower it, or lift it with "No limit" (a null amount).
- Among a person's groups, only those with a rule for that limit take part: the most generous
  of them wins, and one "No limit" lifts it. A group without one takes no part, so a member of
  a group that lowers a limit and of one silent on it gets the lowered one. With no group rule
  at all, everyone's holds.
- Every limit that remains applies, so a daily and a monthly one hold together.
- A group's rule for one of everyone's limits follows it to other models. Changing what it
  counts or its period removes the group rules, since their amounts meant something else, and
  so does removing it, unless another of everyone's rules still means the same limit. Left in
  place, a group's raise would turn into an extra limit of its own. "No limit" can only be
  saved against one of everyone's limits.
- Of several limits used up, the refusal names the one that resets last.
- Two of everyone's rules can come to mean the same limit once a model is deleted; the
  stricter holds. A rule whose models are all gone limits nothing.

This differs from capabilities on purpose. There, joining any group replaces the defaults,
which for limits would leave a member of a group with no rules unlimited by accident.

## What is counted

- Settled ledger rows only ([analytics](analytics.md)). An answer still running counts once
  it settles, so two sends at once may both pass and overshoot a little. That keeps every
  answer whole and needs no reservation. Nothing is ever stopped halfway.
- Cost sums every row kind the person caused: answers, titles, summaries, research,
  embeddings, OCR, images. A row without a cost adds nothing, so a model without a price is
  not held by cost limits.
- Answers count chat rows that did not fail, a stopped one included, so stopping and resuming
  counts twice. A research run writes a chat row of its own, marked with the generation it
  ran in (`generation_id`, which an answer's row never has), and is left out. The mark is on
  the row itself because the run and its tool call go with their chat, or with a retry, while
  the ledger stays.
- A model limit counts only that model's rows. A deleted model's rows lose their model id,
  so they leave its limit too.

## Periods

Calendar periods in one instance-wide time zone (`limit_settings`): a day from midnight, a
week from Monday, a month from the 1st. Bounds come from the database clock (`date_trunc` in
that zone), never the server's, like every other due-ness check here.

## Where it is held

- The attempt resolver (`attempt-options.ts`), inside the transaction under the account lock
  every claim takes. So send, structured answers, retry, edit, resume, queue promotion,
  scheduled runs and turns from connected apps are refused alike, before any row is written.
  A steer joins a running answer and starts none.
- A new research run is admitted through the same check, refused as a tool result.
- Titles, summaries and indexing are counted but never stopped; they belong to work already
  allowed.
- The refusal is `UsageLimitReached` (429) with a sentence naming the limit and its reset.
  It shows as the sender's toast, a queued message's note, a scheduled run's error, and a
  connected app's tool error. Admins are never limited.
- The chat model list carries `limitedUntil`, and the pickers that start answers disable such
  a model. Choosing a model for an agent or a schedule is not spending, so those do not.
