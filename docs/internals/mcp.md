# MCP servers

An admin can add any remote Model Context Protocol server as an integration of the `mcp`
type. Everything integrations already do applies to it unchanged: per-person connections,
allow, ask or block per tool, approvals, schedule grants, tool rows, citations, branch and
reload. This page is what MCP adds. Read [integrations](integrations.md) first.

## Tools come from a catalog an admin approved

A shipped type's tools are code. An MCP server's tools are whatever it lists, and a server
can change a description at any time, so a description is the one input a server writes
straight into the model's context. That is the attack (tool poisoning, a "rug pull") the
design is built around. The model therefore only ever sees descriptions an admin approved.

`integration_tool_catalogs` keeps two lists per integration. `approved` is what the admin
reviewed, with their decisions (on or off, and the access class). `latest` is what the server
listed at the last check that worked. Each entry carries a fingerprint over everything the
server said about the tool (name, title, description, both schemas, annotations), computed
over canonical JSON so a reordered schema is not a change. A generation offers a tool only
when it is approved, on, supported, and `latest` lists it with the same fingerprint:

- unchanged tools keep working;
- a new or changed tool waits for review, never runs under words nobody read;
- a tool the server dropped is gone at once, the safe direction.

The same check runs again as each call goes out, after any approval wait, against the
fingerprint and access the answer was offered: a tool turned off, reclassified or changed
meanwhile does not run, however long the answer has been going.

An approval names the listing it was made on (`version`, a hash of the names and
fingerprints), so an admin cannot approve a listing they did not see. Offered tools keep
the server's order and a model-facing key fixed at first approval, which keeps the tool
block byte-stable for [prompt caching](prompt-caching.md) and never renames a tool the
model already knows.

An approval is of one server, not of words that happen to match: moving the integration to
another address empties both lists in the same transaction, and the review starts over.

Checks run when the admin asks, and in the background through `IntegrationCatalogSweep`
(a claim with a lease, like schedules, every ten minutes). Each check takes a token as it
starts and only the newest token may write, so a slow check never puts back a listing a
newer one replaced, and a move voids any check still running. Each check sets the next one
from the server's `ttlMs` hint, between an hour and a day. A check runs as the admin who last
reviewed, since listing may show what only an account can see. An open or shared-key server
needs nobody.

## Access is the admin's call, defaulting to the worst case

Annotations are hints from a party we do not trust, so the spec's defaults apply.
`readOnlyHint` reads as read; `destructiveHint: false` as a write; anything else, including
saying nothing, as destructive. A destructive tool always asks unless a person allows it in
Settings, and never runs in a scheduled run. The review shows the hint and lets the admin
choose; their choice sticks across later listings.

## Ways in

The admin picks one per integration, and it is part of the fingerprint, so changing it asks
everyone to reconnect:

- **Each person signs in** (OAuth, below).
- **Each person pastes a token**, sent as a bearer token or in a header the admin names.
- **No sign-in**: a person still turns it on, which gives them their own tool permissions.
- **One key for everyone**: the admin's key, encrypted on the integration. Every call acts
  as the admin's account for whoever is chatting, which breaks the rule that authority
  belongs to the sender, so only `read` tools are offered and `consentFor` refuses
  anything else (`shared`). The check is in the tool layer, not only the UI.

## Sign-in follows the 2026-07-28 authorization spec

Endpoints are not fixed per type; `DiscoveredOAuth` finds them when a sign-in starts. The
service keeps what it always kept (the hashed state row, the browser-bound cookie,
encrypted storage, the `FOR UPDATE` refresh). The adapter speaks OAuth through the SDK's
functions:

- **Discovery.** An unauthenticated request returns a 401 whose `WWW-Authenticate` names the
  protected resource metadata, else the well-known paths. That metadata names the
  authorization server, whose metadata is RFC 8414 with an OIDC fallback. A server without
  S256 PKCE is refused. A resource that names another origin is refused.
- **Client, in the spec's order.** The admin's pre-registered client, else one registered
  before with this issuer, else a Client ID Metadata Document, else dynamic registration
  (`application_type: web`). Registrations are stored per issuer
  (`integration_oauth_clients`) and never shown to another. The admin's client is pinned to
  the issuer it was first used with, on the integration row and in one statement, so two
  first sign-ins cannot pin two issuers and no registration is overwritten. A server that
  later names another authorization server never receives its secret; another client ID or
  server address clears the pin. A metadata document is offered
  only from an operator-declared public HTTPS `PUBLIC_URL`, because a server that cannot fetch
  it fails the whole sign-in.
- **Request.** PKCE, the `resource` indicator on authorize, token and refresh, and scopes
  taken from the challenge, else from `scopes_supported`, plus `offline_access` when offered.
- **Callback.** The issuer recorded at the start travels in the state row, and RFC 9207
  `iss` is checked against it before the code is spent. When the server advertises `iss`,
  a missing one is refused too.
- **Step-up.** A 403 `insufficient_scope` records the scopes a call lacked on the connection.
  Settings then offers "Grant more access", which asks for the union of what was granted and
  what was missing.

## Containment

Requests to the configured server go to its origin only, with redirects refused, so a
bearer token never leaves for another host. The origin is the admin's choice and may be
private, like a self-hosted Outline. Every other address (protected resource metadata on
another host, the authorization server, registration) comes from the server, so it goes
through `resolvePublicHttpUrl` and `fetchPinned`. A self-hosted authorization server on a
private network is therefore refused unless it shares the MCP server's origin; that is the
price of not letting a server point us at the internal network. Responses are capped at
25 MB, results at 40 000 characters before the model sees them, files at 8 per call and
10 MB in total.

The SDK client lives for one call. A current (stateless) server costs no extra round trip,
since the era verdict and `server/discover` result are cached for ten minutes. A legacy
session never outlives the answer that opened it. Stop interrupts the call, which aborts
the request.

## Results

Structured content wins when the tool declares an output schema; otherwise the text blocks.
A `resource_link` or text resource with an http(s) URI becomes an integration source,
citable like Outline's. Images, audio and blobs become [files](files.md) of the answer,
delivered under the generation fence like a custom tool's, and shown to the model when it
can read them. `isError` is a failed call in the server's words. Arguments are checked
against the approved schema before anything is sent, so the model learns which field is
wrong.

## Elicitation

A server may ask the person something mid-call: a legacy server with
`elicitation/create`, a 2026 one by answering `input_required` (MRTR). The SDK turns both
into one handler, which parks on `IntegrationApprovals` exactly like an approval (same row
handoff, Stop and lease interruption, `integration.approval.changed`) as a `kind:
"elicitation"` entry with a prompt. A server may ask several things at once; the person sees
them one at a time, each under its own `promptId`, and an answer names the question it
answers, so a tab still showing the last one cannot answer the next.

- **Forms** are limited to the spec's primitive fields. One the app cannot draw faithfully is
  declined, never half-asked. The answer is checked against the form on the server, since the
  browser is not a boundary, and the card says not to type secrets.
- **URL requests** must be https. The card names the host before anything opens and never
  opens it for the person.
- **Nobody there to ask** (a scheduled run, a check) means a decline. Answers are not stored.

## Not yet

Prompts and resources are not used: resources would make a natural knowledge source
through the existing sync, and prompts a skill-like entry. Stdio servers are out, since
every call here carries one person's credentials and a local process would need its own per
person; the desktop app is the place for those.
