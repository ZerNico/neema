# Prompt caching

A chat prompt is laid out so everything up to the end of retained history is byte-identical
from one turn to the next, and only what follows is rebuilt per request. Providers cache a
prompt by its prefix, in the order tools, system, messages, so one changed byte early on
makes everything after it uncached. The model sees the same prompt either way; the cost is
the whole input again on every turn.

## Layout

- Stable, in order: the tool list, then one run of system messages (base policy, tool
  policies, memory, project and agent instructions, all built in `system-prompt.ts`), then
  retained history (skill replays included, see [skills](skills.md)). A compaction summary
  sits between them as a user-role block.
- After history, fixed for the whole answer: draft, document and knowledge data, the skill
  catalogue and pinned roots, kept drafts and the runtime clock, as the answer's first
  request saw them. Then the answer's rounds.
- After the rounds, rebuilt per request: whatever in that trailing data changed during the
  answer (an edited draft or document, a skill loaded mid-answer), then the reminder. The
  data policies say a later snapshot replaces an earlier one. Rewriting the data ahead of the
  rounds instead uncached every round each time a tool touched a draft.
- History renders the same whatever the attempt is offered: citation markers stay in
  earlier answers even with search off, and an attempt with nothing to cite gets a line in
  the trailing reminder instead. Stripping them per toggle rewrote every earlier answer.
- Nothing in the trailing context is system role. Relays that translate to Claude hoist every
  system message, wherever it sits, into the one system block, and a per-turn policy there
  uncaches the tools and the whole history too. Trailing policies are user-role
  `<application-policy>` messages, like the runtime clock.
- Text in the stable part does not follow per-turn state. The memory policy is one fixed
  text that names `save_memory` conditionally rather than changing when the tool is left out.

## Cache points

- Streaming marks up to four anchors (`cacheAnchor`, `anchorLastMessage`): the last system
  message, the end of retained history, and the last two completed rounds of the answer, so
  a long tool loop reads its earlier rounds from cache. The second round anchor covers a round
  with more blocks than one anchor looks back over. The mark is provider-neutral and inert;
  the gateway alone decides what it means.
- A round ends on its tool results, which the adapter sends as plain strings. The
  `@effect/ai-openrouter` patch sends an anchored tool message's last result as a text part
  so it can carry `cache_control`.
- Chat requests to OpenRouter carry the conversation id as `session_id` and
  `prompt_cache_key`, keeping a conversation on the provider that holds its cache. Other
  servers never see them.
- Claude caches only at explicit points, so for an `anthropic/` model on OpenRouter the gateway
  turns each anchor into `cache_control`. OpenAI, Gemini, DeepSeek, Grok and local servers
  cache a stable prefix by themselves and never see a marker, which also keeps strict
  OpenAI-compatible servers from rejecting an unknown field.
- 9router discards client markers and places its own: its system text, last tool, and last
  assistant message. Only a stable system block and tool list matter there. Its OpenAI-shaped
  usage has no `prompt_tokens_details`, so the ledger shows no cached tokens even when the
  cache hits.

## Lazy tool families

- Tool schemas are part of the prefix and are paid on every uncached request. Families that
  are large or rarely needed (the Office editors, agent and schedule drafting) are offered by
  name only: a stable system section lists every offered family, and `load_tools` loads one.
  `tool-load.ts` is the registry.
- The toolkit always holds every offered tool; a request advertises a subset through
  `toolChoice: { oneOf }`. A call to an unadvertised tool still runs and loads its family,
  rather than failing the generation. For the Hermes polyfill, the gateway passes the
  toolkit's names (`HermesCallableTools`) so such a call parses as a call, not text.
- What is loaded is derived from rows, never stored: an explicit load, a call to the family's
  tools, the authoring skill that drives it, a kept draft or an attached Office file, within
  retained history and the current answer. It is decided once per answer and only grows
  during it. Compaction can drop the rows that loaded a family; it is offered again then.
- Each load changes the advertised tools, so it costs one cache miss per family per chat.
  The catalogue itself never changes as families load.

## What still breaks the cache, deliberately

- The composer's search and research toggles change the tool list, and so the whole
  prefix, for that turn. The tools offered are the toggle's meaning; keeping disabled tools
  on offer was judged not worth it for a rarely flipped switch. Integration toggles do the
  same, which is why they stick per chat rather than resetting per message: flipping one
  recaches once, not on every send. See [integrations](integrations.md).
- A saved memory changes the memory block ahead of history in every chat. Switching model,
  editing a custom tool or skill, and compaction summaries are rarer and accepted.
