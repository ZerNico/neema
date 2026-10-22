# MCP servers

An admin can add any remote Model Context Protocol server as an integration of the `mcp`
type. Everything integrations already do applies to it unchanged: per-person connections,
allow, ask or block per tool, approvals, schedule grants, tool rows, citations, branch and
reload. This page is what MCP adds. Read [integrations](integrations.md) first.

## Tools are what the server lists to each account

A shipped type's tools are code. An MCP server's tools are whatever it lists, and a server can
change a description at any time. Whoever adds a server vouches for it: the admin for a shared
one, the owner for their own. So what it lists is offered as listed, at the access it claims,
with nobody approving each change. The admin's word on single tools (`tool_settings` on the
integration: off for everyone, or a corrected access) applies on top and never waits on a
listing.

Accounts may see different tools (one Atlassian account has Confluence, another not), so
`integration_tool_listings` keeps one listing per account, keyed by its connection. A way in
with no account of one's own (open, or the admin's key) shows everyone the same tools, so it
keeps one listing with no connection. A session offers its account's listing, without the
tools that cannot be offered, in the server's order, capped at `MCP_LIMITS.enabledTools`. With
several accounts in a chat, each tool is offered for the accounts whose listing has it, and a
call goes out with that account's own version.

Each entry carries a fingerprint over everything the server said about the tool (name, title,
description, both schemas, annotations), computed over canonical JSON so a reordered schema is
not a change. The check runs again as each call goes out, after any approval wait, against the
fingerprint and access the answer was offered: a tool turned off, reclassified or changed
meanwhile does not run, however long the answer has been going. A tool keeps its model-facing
key from the first listing that named it, across every account's listing, which keeps the tool
block byte-stable for [prompt caching](prompt-caching.md) and never renames a tool the model
already knows. A server whose tools run long is offered by name until the model loads it with
`load_tools`, like the Office editors; see [lazy tool families](prompt-caching.md#lazy-tool-families).

A new account lists at once, in the request that connected it, so it has tools straight away.
Afterwards `IntegrationCatalogSweep` lists what is due (a claim with a lease, every ten minutes,
only for integrations that are on), each listing with the account it belongs to, and only while
that account may still use the integration. Each check takes a token as it starts and only the
newest token may write, so a slow check never puts back a listing a newer one replaced. Each
check sets the next one from the server's `ttlMs` hint, between an hour and a day. An admin's
"check now" lists without an account where the server allows that, and with the admin's own
accounts, never anyone else's.

Another server (a new fingerprint) deletes every listing in the same transaction as the save.

## One server per revision

Several things outlive the moment they start: a check, a sign-in, a prepared call waiting
for approval, a refresh waiting for its row lock. Each must finish
against the server it started with. Comparing addresses read earlier does not hold: a save
in between, or a move away and back, passes any such comparison.

So `integration_configs` keeps the adapter's fingerprint of its setup and a `revision`. A
save locks the row, compares the stored fingerprint and client ID with the new ones, and
bumps the revision when either changed; only then does it drop the listings and the issuer
pin. The admin's word on a tool is not part of it, so turning a tool off reconnects nobody. Everything started under a revision carries it, and every write it makes requires it
in the same statement: recording a check, pinning an issuer, saving a connection (a sign-in
whose code exchange outlived a save fails like one that found the save first), and handing
a session its credential, which a refresh checks again with the integration's row and then
the connection's locked. This applies to every integration type, not only MCP, and
sits beside the per-credential identity in [integrations](integrations.md): the revision
names the server, the account epoch and credential revision name whose token it is.

## Access defaults to the worst case

Annotations are the server's own word, so the spec's defaults apply. `readOnlyHint` reads as
read; `destructiveHint: false` as a write; anything else, including saying nothing, as
destructive. A destructive tool always asks unless a person allows it in Settings, and never
runs in a scheduled run. Whoever vouched for the server corrects a tool whose claim is wrong:
the admin on the integration's page, the owner of a server of their own in Settings. Either is
the same `tool_settings` entry, kept by the server's name for the tool so it sticks across later
listings.

## Ways in

The admin ticks any of three ways in: signing in, pasting a token, or going without an account,
which is either open to anyone or one key for everyone. Several may stand at once, since many
public servers take a token for private data or higher limits. Each person picks one; Settings lets someone using it without
an account add their own later, which replaces using it without one. An MCP server says
nothing stable about who signed in, so each sign-in or token adds an account unless it
reconnects a named one.

- **Signing in** is OAuth, below. **A token** goes as a bearer token or in a header the admin
  names.
- **Open**: a person still turns it on, which gives them their own tool permissions.
- **One key for everyone**: the admin's key, encrypted on the integration. Every call acts
  as the admin's account for whoever is chatting, which breaks the rule that authority
  belongs to the sender, so a connection on it is offered only `read` tools and `consentFor`
  refuses anything else (`shared`). The check is in the tool layer, not only the UI.

Either way without an account may be **on for everyone**. Then nobody presses anything: the
connection is made when the person's integrations are read (Settings, a chat's list, an
attempt's offer), without asking the server, since it holds nothing personal and the admin's
save already checked it. It is on in new chats like any fresh connection. Such a connection
cannot be disconnected, since the next read makes it again; it is turned off per chat or for
new chats instead. A person's own sign-in or token replaces it and is never replaced back, and
disconnecting that returns them to the shared way. When the admin moves the server or changes
which way without an account it uses, those connections follow on the next read.

The fingerprint names where credentials go (the address and the header), not which ways are
open, so opening another way asks nobody to reconnect and keeps the listings. A connection
whose way the admin closed reads as needing to reconnect, judged by its kind wherever a
session or credential is handed out.

## Known servers

`mcp/known-servers.ts` names servers people commonly connect (Atlassian, Notion, Linear and
others), each checked to sign in without registering an app first. Adding one is adding an
ordinary MCP integration at its address with signing in as its way in, on at once: there is
nothing to fill in. The exception is marked `ownApp`: a sign-in that lets in only apps registered
there (Asana's V2 server). It is added off and opens on its settings for the admin's client ID and
secret, and cannot be turned on without them; it is an admin's preset only. Which known server an
integration is, for its logo and description, is read from its address each time, not stored.
Some services need their own admin first, which nothing here can do or detect: Atlassian lets in
only domains its organization admin allowed, so its `setup` note names this app's origin before
anyone tries to sign in.

## Servers a person adds

With the `mcpServers` capability, a person may add a server for themselves. It is an
ordinary `integration_configs` row with an `owner_user_id`, so everything above applies, with
the owner where the admin would be: the sweep lists as them, and only they may use it.
`integrationUsableBy` decides this in SQL, so losing the capability, or the account, stops the
server everywhere at once without deleting it. Others never see it: not in their lists, the
directory or the admin's page, and an agent cannot name one that is not the author's own.
Names are unique among what one person sees (the admin's and their own), not across everyone.
Ids are one space with the admin's, so a person's server takes its name plus a tag of its
owner: a bare name would take an id an admin's integration wants (and its tool names and
redirect URI with it) and, taken, tell the admin that someone has a server by that name.
A server whose sign-in neither registers apps nor reads metadata documents (Asana's) takes an
app the person registered there: the probe says so, the row is saved first so its redirect URI
exists, and its client ID and secret are asked for before the sign-in, which would only fail.
The secret is encrypted like the admin's and never sent back, and goes when signing in does.

A person gives only the address. The server is asked how it is reached rather than the person:
answering as nobody makes it open; refusing, and naming an authorization server with PKCE,
makes it signing in; refusing without one, a token. Open, it is done once saved. Otherwise it
is a `draft` until its first account connects, since signing in needs the row and its callback
names it: no list, directory or offer shows a draft, only its own setup, and going back deletes
it. One person adds one at a time, so a new one replaces any left half added, and the sweep
deletes drafts older than an hour.

The address is the one thing that differs. An admin's server may be private because the admin
chose it; a person's must be public HTTPS, or anyone could point the app at the internal
network. The server sets `reach: public` on the config, a key no form can send, and with it
every request, to the server's own origin too, goes through `resolvePublicHttpUrl` and
`fetchPinned`, so a name that later resolves inside is refused like any other address. A person
cannot hold a shared key or turn a server on for everyone, since there is nobody else to act
for, and signs in only with a client found at sign-in, never an admin’s.

## Sign-in follows the 2026-07-28 authorization spec

Endpoints are not fixed per type; `DiscoveredOAuth` finds them when a sign-in starts. The
service keeps what it always kept (the hashed state row, the browser-bound cookie,
encrypted storage, the `FOR UPDATE` refresh). The adapter speaks OAuth through the SDK's
functions:

- **Discovery.** An unauthenticated request returns a 401 whose `WWW-Authenticate` names the
  protected resource metadata, else the well-known paths. That metadata names the
  authorization server, whose metadata is RFC 8414 with an OIDC fallback. A server without
  S256 PKCE is refused. A resource that names another origin is refused.
- **Client, in the spec's order.** The integration's own pre-registered client (the admin's,
  or a person's on a server of their own), else one registered before with this issuer, else
  a Client ID Metadata Document, else dynamic registration (`application_type: web`). Registrations are stored per issuer
  (`integration_oauth_clients`) and never shown to another. The admin's client is pinned to
  the issuer it was first used with, on the integration row and in one statement, so two
  first sign-ins cannot pin two issuers and no registration is overwritten. A server that
  later names another authorization server never receives its secret; a new revision clears
  the pin, and a sign-in started under an older one pins nothing. A metadata document is offered
  only from an operator-declared public HTTPS `PUBLIC_URL`, because a server that cannot fetch
  it fails the whole sign-in.
- **Request.** PKCE, the `resource` indicator on authorize, token and refresh, and scopes
  taken from the challenge, else from `scopes_supported`, plus `offline_access` when offered.
- **Callback.** The issuer recorded at the start travels in the state row, and RFC 9207
  `iss` is checked against it before the code is spent. When the server advertises `iss`,
  a missing one is refused too.
- **Step-up.** A 403 `insufficient_scope` records the scopes a call lacked on the connection,
  only while it still has the account epoch of the session that made the call: a refusal
  landing after the person signed in again does not ask a second time. Settings then offers
  "Grant more access", which asks for the union of what was granted and what was missing.

## Containment

Requests to the configured server go to its origin only, with redirects refused, so a
bearer token never leaves for another host. The origin is the admin's choice and may be
private, like a self-hosted Outline. Every other address (protected resource metadata on
another host, the authorization server, registration) comes from the server, so it goes
through `resolvePublicHttpUrl` and `fetchPinned`. A self-hosted authorization server on a
private network is therefore refused unless it shares the MCP server's origin; that is the
price of not letting a server point us at the internal network. One piece of work (a call,
or a listing with all its pages, which also has one two-minute deadline) reads at most
25 MB; results are capped at 40 000 characters and 20 citations before the model sees them,
files at 8 per call and 10 MB in total.

The SDK client lives for one call. A current (stateless) server costs no extra round trip,
since the era verdict and `server/discover` result are cached for ten minutes per
credential, and forgotten when a request relying on them fails. A legacy session is ended
when its work is, also when the handshake that opened it failed. Stop interrupts the call, which aborts
the request.

## Results

Structured content wins when the tool declares an output schema; otherwise the text blocks.
A `resource_link` or text resource with an http(s) URI becomes an integration source,
citable like Outline's. Images, audio and blobs become [files](files.md) of the answer,
delivered under the generation fence like a custom tool's, and shown to the model when it
can read them. `isError` is a failed call in the server's words. Results are never checked against the
tool's output schema: that would run the server's patterns on the server's own text, which
it can write to stall the process, and a check failing after the call ran would read as
refused and invite a repeat.

## Two schemas per tool

A tool keeps two copies of its input schema. The model is shown one with local references
inlined in one dialect, since providers handle `$ref` and draft-07 unevenly. Arguments are
checked against the other, the server's own as written, before anything is sent, so the
model learns which field is wrong. Inlining is lossy; keeping the check on the original means
a mistake there can make the model's view vaguer but never lets a wrong argument through.
The checked copy only drops what makes checking unsafe: `$async`, and patterns that can
backtrack exponentially, which the server still enforces itself. Every listed tool is
processed alone, under node, character and depth budgets, so one hostile schema refuses that
tool and nothing else.

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
