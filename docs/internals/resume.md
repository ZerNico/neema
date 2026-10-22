# Resuming an answer

Retry throws an answer away and starts over. Resume keeps it: the same assistant row gets a new generation that continues from what the answer already produced. It exists for long tool-heavy answers, such as building a deck, where a provider error, a crash or Stop would otherwise cost every completed round.

## Claim

- Only the conversation's last turn can be resumed (`turnMessagesOf`, so the answer's own steers do not count as later), only when it is `error` or `aborted`, and only while nothing streams. A later turn was answered without whatever the resumed answer goes on to say, so there is no mid-history resume.
- `resumeMessage` takes the conversation lock like retry, mints a new `generation_id` and lease, and re-resolves the attempt configuration exactly as a retry does. Nothing the answer produced is removed: chunks, tool rows, files, documents, drafts and compaction events all stay. The new generation id is the fence; the ended attempt's late writes are refused like any superseded attempt's.
- Content is set to the joined text chunks, as the reaper reads them, because the client rebuilds a streaming answer from chunks alone. A branch copy has content but no chunks, so its text becomes the first chunks.
- Choosing another model clears `provider_replay`: signed image turns belong to the model that wrote them and are never merged with another model's. An answer whose host turns are used up is refused before the claim, so a resume that cannot succeed never replaces its error.
- Queued steers aimed at the ended attempt are retargeted to the new generation. They were meant for this answer.

## One continuous space

- The new attempt starts `seq` at the last chunk and its text at the stored text, so chunk sequence and text offsets stay one contiguous space and the live view simply continues.
- Its first turn (`resumeFirstTurn`) is one past every host turn the answer used: tool rows, compaction events, steers, files and signed replay turns, since an image model's round can leave no other row. Every write keyed by turn, including direct knowledge context, pinned skill rows and the initial history compaction, uses that turn, so the unique positions never collide. Budgets and first-call logic count the attempt's own rounds; each attempt gets the full round budget, bounded only by the research ordinal space above it (`RESEARCH_TURN_BASE`).
- A knowledge context or pinned skill row the answer already shows is not written again unless the context brought sources the old row lacks.

## What the model reads

- The answer's own rounds come first in the continuation, each as one compactable round: its text, then an assistant-role `<application-record>` listing each call, its stored arguments and result summary, then any steer it took in. Tool data stays verbatim, because the model copies names and arguments back into calls; only the record's own tag is neutralized, and nothing is promoted to a user instruction. They are records, not replayed tool-call parts: rows keep only a trimmed copy of their arguments (`stored-arguments.ts`: written content becomes its length, and memory, draft and document calls keep none, their content owning a deletable row of its own), and providers reject unsigned replayed tool turns. An image call keeps its prompt whole: it exists nowhere else, and refining an image starts from it. Neither records nor replayed history calls show what was left out, not even as a placeholder: models copy earlier calls, and a copied placeholder went through as an image prompt, while a copied absence meets the handler's own answer for a missing argument. A failed call's full arguments are kept aside for a week for debugging, never for those owned-content families or typed browser text, and never replayed. Native and Hermes models read them the same way.
- Retained generated images are replayed as assistant file parts at their original text offsets, or as the [stand-in](files.md#what-the-model-sees) for a model without vision. On the model that wrote them, a signed turn keeps its exact span and reasoning details, and its record follows it as a separate message rather than inside the signed unit. An image whose attachment is gone is left to its record line.
- Saved drafts are named once each, at their latest saved revision, in the kept-files notice. Records never repeat a draft reference per call, because earlier revisions may never have been kept.
- A call the stop, crash or failure settled (`GenerationFailed`) reads as "outcome unknown". Desktop commands, integration writes and publishes may already have happened.
- The first call carries a trailing reminder: continue where the text stops, repeat nothing, re-read anything a summary lacks.
- The answer's own sources seed the indexer, URL authority and recap, so its citation numbers keep their meaning and links it found stay readable.
- The plan checklist continues from the last accepted list, and a `save_memory` row on the answer spends its one save. Knowledge operations, preview budget and the web search cache are per attempt and start fresh.

## Files and accounting

- Kept drafts already include the answer's own rows, and a keep updates the same (file, answer) row, so a resumed deck edit continues from the last saved round. Drafts made only in the lost round are gone; a stale revision is refused with the current one named, which the model can recover from. Retrying after a resume still restores what the answer started from.
- Each attempt appends its own `usage_events` row. The message's `usage` sums the attempts, because its text spans them.
- A research run was fenced by the attempt that started it and stays terminal; the model may start another. A run may settle its own call row after its generation ended, and resume keeps that row.
- Saved ```ui block state and the images its blocks found stay with the row. The new attempt skips image queries already settled and counts them against the answer's caps. See [generative UI](generative-ui.md).
- The client drops a `writing` marker whose `runId` names an earlier attempt: that attempt ended mid-call, so nothing would ever replace it.
