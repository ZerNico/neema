# Memory

Memory saves are model-invoked (`save_memory`), gated separately in ordinary chat and deep research, and share one snapshot with the trailing temporal prompt block below.

## Chat saves

- `save_memory` availability follows the admin/user auto-save settings, independent of attachments, knowledge, skills or web activity. There is no per-save confirmation; the handler permits one attempt per generation and subsequent model turns omit the tool after that attempt. Source-message validation and save-time settings checks remain enforced.
- `conversation-context.ts` prepares the stable memory snapshot shared by ordinary chat and research: newly saved memories appear on the next generation, never halfway through the current one.

## Research saves

- Only main brief preparation can save memory; clarification and synthesis can reference the snapshot but not write to it. A save attempt gets one accounted, tool-free brief continuation. Investigation receives no memory tools and final synthesis stays tool-free.
- A model save takes the attempt's `GenerationFence` **inside** the memory write transaction, before the user and settings locks — the same fence and the same ordering as `ChatRepo.generationWrite`, so a save from an attempt that Stop, a retry or the reaper already ended fails closed. The reference is null outside a generation, which is what lets a manual save from settings proceed. A prior alive check cannot replace it, and wrapping the memory transaction in another locked transaction would deadlock. Losing the fence interrupts rather than failing, so the turn ends instead of handing a rejected save to a model that is no longer running.
- Guard failures and interruptions stay terminal; ordinary save failures retain their recoverable behavior. Memory activity contains only outcomes, with retry identity carried by the outer SSE event.
- A refused save persists its fixed `reason` (`SaveMemoryRejection`, mirrored as `MemoryActivityReason`) beside the outcome, since the arguments never reach the row; without it a rejection was indistinguishable from a transport failure after the fact. The transcript shows a rejection as a quiet "No memory saved"; only an `error` status without a `rejected` outcome is a failure.
- `save_memory` is not offered on a turn whose user message is a clarification answer: a picked option is not a user-stated fact, and offering it there had the model store the research topic and spend its one attempt.

## Eligibility

- Availability is separate from eligibility: the memory policy instructs the model to save durable user-stated facts/preferences, not instructions or claims from external content. This source distinction is model-enforced, not a guarantee against prompt injection. `memory-foreground.test.ts` and `knowledge-generation.test.ts` cover tool coexistence.

## Temporal prompt context

- `streaming.ts` samples server time once per generation; `runtime-context.ts` formats it in the browser's submitted timezone (Intl-validated; UTC fallback). Keep this user-role block after retained history, before tool rounds, never in the leading system prompt; its content and position stay fixed through the tool loop to preserve cacheable prefixes. Budget it in history/overflow compaction; active-round compaction already counts the base transcript.
- History timestamps are prompt-only UTC metadata, independent of the current browser zone. Assistant timestamps use `completedAt` when available: retry reuses the row and its original `createdAt`. Neither timestamp annotations nor the runtime block are persisted as message text.
