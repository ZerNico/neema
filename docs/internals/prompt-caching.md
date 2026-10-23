# Prompt caching

A chat prompt only ever grows at its end: a new turn's request opens with the previous answer's
first request, and within an answer each request extends the one before it. Providers cache a
prompt by its prefix, in the order tools, system, messages, so one changed byte early on
makes everything after it uncached. OpenAI from GPT-5.6 also reads only where an earlier
request ended (its automatic breakpoint is the end of the latest message), so a prefix
shared only part of the way is not read at all. The model sees the same prompt either way;
the cost is the whole input again, at the write price, on every request.

## Layout

- Stable, in order: the tool list, then one run of system messages (base policy, tool
  policies, memory, project and agent instructions, all built in `system-prompt.ts`), then
  retained history (skill replays included, see [skills](skills.md)). A compaction summary
  sits between them as a user-role block.
- After history, the answer's opening, fixed for the whole answer: draft, document and knowledge
  data, the skill catalogue and pinned roots, kept drafts, the image model the answer draws with
  and the runtime clock, as its first request saw them, then its first reminder. Then the
  answer's rounds. The image tool's schema stays the same whichever model it uses, so picking
  another never uncaches the tool list ([images](images.md)).
- The opening is kept on the answer (`messages.opening`, server only) and history replays it in
  place, after its user message, so the next turn extends that answer's first request. It holds
  only what retained history's openings do not already show, by block (first line, or first two
  under a bare tag) and content; a source's blocks (a document's policy and view, knowledge
  evidence and the line about it) go again together. It ends on the clock, so a request never
  ends on a data block, then a line for any block that vanished, said once. What history cannot
  replay as the model saw it (an answer's tool rounds, rendered from their rows) is written once
  more on the next turn; nothing before it is. A retry or edit sends a new opening; a resumed
  answer keeps the one it began with; a branch, a new conversation with its own cache, keeps
  none. Compaction counts replayed openings but never summarizes them, since each attempt shows
  their data again under its own access.
- Replaying an opening is not a grant. Each block records what rendered it (the agent or schedule
  authoring permission, documents and the chat's project, the agent's collections, skills, the
  image model) and the documents, knowledge documents, skills, skill revisions and kept drafts it
  shows (`needsOf`, from their renderers' markers), and history replays it only while the
  attempt may still show all of them; otherwise it is left out, which costs one cache miss and
  only when access changed. Pinned skill instructions carry their revision, so an edited skill is
  never replayed at its old one. A reminder records the earlier sources its recap listed, and a
  later one lists only those neither a replayed reminder nor a replayed tool result already shows.
- Each request ends on what changed during the answer (an edited draft, a skill loaded
  mid-answer) and then the reminder, and that tail stays where it was sent, ahead of the round it
  produced. The next request adds only what changed since: new sources, a changed checklist or
  draft. OpenAI from GPT-5.6 writes its cache at the end of the latest message, and reads only
  where an earlier request wrote: a tail rebuilt per request was never read again, so every
  round of a search loop paid to write its whole prompt. Append-only works the same for any
  provider that caches by prefix, with no list of models. A changed section is sent whole and
  the newest reads as current; the data policies say a later snapshot replaces an earlier one. A
  document keeps its first view as it was and sends its changes since, cumulatively
  ([documents](documents.md)). Compaction drops kept tails with their rounds, so the next tail
  says everything again. Rewriting the data ahead of the rounds instead uncached every round each
  time a tool touched a draft.
- A research worker follows the same rule: each round's budget notice stays ahead of the round,
  and its source manifest is the one the task started with, since what it finds later is in its
  tool results. A manifest that grew per round uncached every round after the policy, Claude's
  included.
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

- Streaming marks anchors (`cacheAnchor`, `anchorLastMessage`): the last system message, the
  end of retained history, the last two completed rounds of the answer, and the end of every
  request, which the next request extends, and the end of the newest replayed opening, where the
  previous turn's first request ended (Claude looks back only about twenty blocks from an anchor,
  and that answer's rounds can be more). Claude then reads the whole previous request, turn to
  turn as well as round to round, as OpenAI does by itself. The model client keeps at most four,
  the first and the latest; the second round anchor covers a round with more blocks than one
  anchor looks back over. The mark is provider-neutral and inert; the gateway alone decides what
  it means.
- For a model that takes markers, every message and tool result goes out as text parts, marked
  or not. A relay merges a plain string and a part into different blocks, so a message whose
  marker moved on (the turn's user message, a round that is no longer among the last two) stopped
  matching the prefix it was cached under. Other models get plain strings, which some servers
  require.
- Chat requests to OpenRouter carry the conversation id as `session_id` and
  `prompt_cache_key`, keeping a conversation on the provider that holds its cache. Other
  servers never see them.
- Claude caches only at explicit points, so for an `anthropic/` model on OpenRouter or Vercel,
  and for every request on the Messages codec (Claude on Bedrock), the model client turns each
  anchor into `cache_control` (at most four, the first and the latest). OpenAI, Gemini, DeepSeek, Grok and local servers
  cache a stable prefix by themselves and never see a marker, which also keeps strict
  OpenAI-compatible servers from rejecting an unknown field.
- 9router discards client markers and places its own: its system text, last tool, and last
  assistant message. Only a stable system block and tool list matter there. Whether its usage
  reports cache reads depends on the route behind it.

## Lazy tool families

- Tool schemas are part of the prefix and are paid on every uncached request. Families that
  are large or rarely needed (the Office editors, agent and schedule drafting) are offered by
  name only: a stable system section lists every offered family, and `load_tools` loads one.
  `tool-load.ts` is the registry.
- A remote MCP server is a family of its own (`integration:<id>`) once what it lists passes
  about 2,000 tokens. `integrations/server/tools.ts` measures the listing alone, never the
  per-chat text around it (accounts, scopes, blocked tools), so connecting a second account
  never moves a server in or out of the catalogue. Its line quotes its tools' titles, the
  server's own text, on one line each. A small server and the shipped integrations, sized by
  us, stay advertised. A blocked tool or a changed listing changes the line, as either
  already changes the advertised schemas.
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

## Side generations

- A title is a small fresh prompt with nothing to share with the chat's cache, so it runs
  on the admin's utility model (`model_settings`) when one is set and enabled, falling back
  to the chat's own model if that fails.
- A history summary is the opposite: it reads the chat's own prompt, so it runs on the
  chat's model with the chat's request settings; see [compaction](compaction.md).

## What still breaks the cache, deliberately

- The composer's search and research toggles change the tool list, and so the whole
  prefix, for that turn. The tools offered are the toggle's meaning; keeping disabled tools
  on offer was judged not worth it for a rarely flipped switch. Integration toggles do the
  same, which is why they stick per chat rather than resetting per message: flipping one
  recaches once, not on every send. See [integrations](integrations.md).
- A saved memory changes the memory block ahead of history in every chat. Switching model,
  editing a custom tool or skill, and compaction summaries are rarer and accepted.
