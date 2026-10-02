# Web search providers

`web_search` searches through an ordered list of providers (`search_providers`): a
self-hosted SearXNG and hosted APIs (Tavily, Brave, Exa, Serper, Jina, LangSearch). Several
rows may share a kind; two keys for one service is how free tiers stack. The model never
learns which provider answered.

## The chain

- Each query walks the list on its own until one provider answers. One tool call with
  three queries may be answered by three providers. The per-generation cache key is still
  query, time range and language, whoever answered.
- **An empty answer ends the chain.** It is a real answer, and trying it elsewhere would
  spend free quota on every query with nothing to find. Only an empty page the provider
  itself marks as failed counts as a failure: SearXNG with every requested engine
  unresponsive (see below).
- Adapters classify failures into closed reasons (`unavailable`, `rate_limited`, `quota`,
  `auth`, `rejected`) from statuses, bodies and reset headers. The chain never reads HTTP.
  Every reason moves on to the next provider. `rejected` is about the query (a 400), so it
  does not affect the provider's health.
- **Cooldowns reorder, never remove.** A failing provider is moved behind the healthy ones
  until its cooldown ends: the provider's own reset time when it sends one, an hour for a
  rejected key, and exponential backoff for outages and bare rate limits. When every
  provider is cooling down, all are still tried in order of soonest recovery. Local state
  can therefore cost one quick failing request, but can never cause an outage of its own.
- Health is process memory, keyed by provider id and version (`updated_at`). One process
  serves the app, so nothing needs sharing, and a restart re-learns an exhausted key with
  one failed request. Editing a provider clears its record; reordering does not, since it
  leaves `updated_at` alone.
- A dated query (`timeRange`) tries date-capable providers first. The rest follow with the
  filter dropped, because older results beat none. A language is passed only where the
  provider supports one.
- Each attempt has its own timeout, and a query starts no new attempt past its deadline.
  Otherwise a list of four slow providers would stall the model for a minute.

## Research

Fallbacks run inside the one permit and budget unit a query was admitted with: the
research budget counts searches the model asked for, not upstream attempts.
`observeSearch` fires once per chain outcome, so `searchOutageThreshold` now means every
provider failed, not that one did.

## SearXNG

- SearXNG returns HTTP 200 with `results: []` plus `unresponsive_engines` for both partial
  and total failure. The adapter requests the enabled general engines from `/config`
  (respecting time-range support) and fails only when every requested engine is
  unresponsive. Missing config or a query bang selector leaves participation unknown,
  which is not evidence of a total outage. HTTP and transport failures still fail outright.
- Its base URL is admin-controlled and may be local, which is the point of self-hosting, so
  it is exempt from `url-safety.ts`. Hosted kinds have fixed endpoints and take only a key,
  so they add no admin-supplied URL. Result URLs still pass the reader's SSRF boundary.

## Provider quirks the adapters absorb

- **Brave:** an invalid key is a 422, not a 401. Its rate-limit headers are comma lists
  (per-second window first, then monthly) with `Reset` in seconds from now. A spent monthly
  window is `quota`, any other window `rate_limited`.
- **Tavily:** 432 and 433 mean credits are used up.
- **Serper:** running out of credits is a 400, so the adapter matches the message.
- **Exa:** returns no snippet unless highlights are requested.
- **Jina:** fetches every result page unless told `X-Respond-With: no-content`, and needs
  `Accept: application/json`. It cannot filter by date.
- **LangSearch:** may report a failure inside an HTTP 200 body, and uses 429 for both a
  rate limit and a used-up daily allowance.
