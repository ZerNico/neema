# Prompt caching

A chat prompt is laid out so everything up to the end of retained history is byte-identical
from one turn to the next, and only what follows is rebuilt per request. Providers cache a
prompt by its prefix, in the order tools, system, messages, so one changed byte early on
makes everything after it uncached. The model sees the same prompt either way; the cost is
the whole input again on every turn.

## Layout

- Stable, in order: the tool list, the system messages and memory, the agent's instructions,
  then retained history (skill replays included, see [skills](skills.md)).
- Rebuilt per request, after history: draft, document and knowledge data, skill catalogue,
  the runtime clock, reminders. Anything per turn belongs here, never earlier.
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

- Streaming marks two anchors (`cacheAnchor`): the last system message and the end of
  retained history. The mark is provider-neutral and inert; the gateway alone decides what it
  means.
- Claude caches only at explicit points, so for an `anthropic/` model on OpenRouter the gateway
  turns each anchor into `cache_control`. OpenAI, Gemini, DeepSeek, Grok and local servers
  cache a stable prefix by themselves and never see a marker, which also keeps strict
  OpenAI-compatible servers from rejecting an unknown field.
- 9router discards client markers and places its own: its system text, last tool, and last
  assistant message. Only a stable system block and tool list matter there. Its OpenAI-shaped
  usage has no `prompt_tokens_details`, so the ledger shows no cached tokens even when the
  cache hits.

## What still breaks the cache, deliberately

- The composer's search and research toggles change the tool list, and so the whole
  prefix, for that turn. The tools offered are the toggle's meaning; keeping disabled tools
  on offer was judged not worth it for a rarely flipped switch. Integration toggles do the
  same, which is why they stick per chat rather than resetting per message: flipping one
  recaches once, not on every send. See [integrations](integrations.md).
- A saved memory changes the memory block ahead of history in every chat. Switching model,
  editing a custom tool or skill, and compaction summaries are rarer and accepted.
