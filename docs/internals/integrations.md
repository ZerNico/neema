# Integrations

An integration lets a person's own account in another service (Outline first) reach chat as
tools and reach knowledge as a synced source. It is the first feature here that carries real
authority into a chat: every call runs as the sender with credentials they supplied. Most of
the design follows from keeping that authority tied to the person and asking before it
changes anything.

## Manifest and adapter

Each integration is two halves with one id. The **manifest** (`<id>/manifest.ts`,
client-safe) is everything a screen needs: name, logo, admin fields, auth methods, the tool
list with each tool's access class and a one-line argument summary, and whether it can be
a knowledge source. The **adapter** (`<id>/server/adapter.ts`) is behaviour: config
normalization, OAuth endpoints, `verify`, tool handlers and the knowledge browse, enumerate
and fetch. `catalog.ts` and `server/adapters.ts` list them; `catalog.test.ts` checks that
every manifest tool has a handler and the reverse. Admin, Settings, the composer, tool
rows, approvals and the source picker render from the manifest alone, so a new integration
is one manifest and one adapter.

Tools are `int_<integration>__<tool>`, family `integration`. As with custom tools, the
prefix is only the durable marker for persisted rows; inside a generation the resolved
offer decides what counts as an integration call. Every tool parameter is
`Schema.optionalKey` and the handler explains a missing one.

Outline is reached through its REST API, not its `/mcp` endpoint: the sync needs REST
anyway, and our own tools keep descriptions byte-stable for caching, let us decide each
access class, and return citable sources. A generic remote-MCP adapter kind is the intended
route for services we will not write an adapter for.

## Configuration, connections and credentials

- `integration_configs` is one row per integration an admin has touched: enabled, the
  admin fields (base URL), an OAuth client, and whether personal API keys are allowed.
  Who may connect uses `SharingService` (`integration` resource, admin-managed), checked in
  SQL by `integrationUsableBy` at connect, at every attempt and at every sync.
- `integration_connections` is one row per (user, integration). Credentials are one
  `KeyCipher` JSON document and never leave the server, tool rows or logs. A connection is
  never shared: an agent or schedule reaches only the sender's own.
- The adapter's config fingerprint (Outline: the normalized base URL) is stored with each
  connection. A different fingerprint reads as `needs_reauth`, and saving a new one marks
  every connection so, since the credentials name another server.
- OAuth tokens are refreshed a minute before expiry under `SELECT … FOR UPDATE` on the
  connection. The lock makes concurrent callers take turns: the first rotates the refresh
  token, the rest find a fresh access token instead of spending a used refresh token. A
  refused refresh (`invalid_grant` and kin) marks the connection `needs_reauth`; a network
  failure does not.
- The admin's base URL is exempt from `url-safety.ts`, like the SearXNG base URL:
  self-hosted Outline is usually on a private network. Requests go only to that origin
  with `redirect: "manual"`, so a redirect elsewhere is refused rather than followed with
  the bearer attached.

## OAuth is bound to the browser that started it

`/api/integrations/:id/connect` needs a session, stores the state (hashed) and PKCE
verifier in Better Auth's `verification` table, and sets an httpOnly cookie holding the
state. The callback needs the same session, the matching cookie and an unexpired, unused
state. Without the cookie check, someone could start a flow as themselves and have another
person approve it, putting that person's account into the attacker's connection.

The desktop shell never loads another origin, so its Connect link opens in the system
browser, through the ordinary `window.open` handling. That browser must be signed in here
as the same person. The shell learns the result from the `integrations.changed` sync event;
it needs no deep link back.

## What a chat is offered

The offer is read as the generation starts (`resolveOffer`, beside custom tools) and held
for it. A chat's own choice (`conversation_integrations.enabled`) wins; otherwise an
installed agent's attachments decide, otherwise the connection's "Offer in chats". A
connection that stopped working drops out rather than failing the turn. The choice is sticky
per chat, not per message, because a changed tool list recaches the whole prefix. An
existing chat saves each toggle immediately; a chat not created yet sends its toggles with
the first message. An `@` mention is only a keyboard route to the same toggle. Branch copies
the chat’s choices and per-tool allowances like it copies the work permission level. Deep research workers are
offered none.

## Consent

Every tool has its own standing permission on the connection: allow, ask or block
(`integration_connections.tool_permissions`, only tools moved off their default). The
default comes from the tool's access class, reads allowed and anything that changes the
service asking, so a tool added to an adapter later starts safe. A blocked tool is left out
of the offer entirely; `consentFor` refuses it too, since Settings can change mid-answer.
An approval's "Always allow in this chat" records that one tool on
`conversation_integrations.allowed_tools`; it lifts an ask in that chat and never a block.
A destructive tool is the exception: only an explicit "allow" in Settings runs it unasked, a
one-off approval cannot, and a scheduled run never does, whatever it was granted.
Permissions are read at call time, so either change applies to the rest of the answer.

Asking parks the handler on `IntegrationApprovals`, a per-call `Deferred` keyed by the tool
row id. The observer releases the handler only after that row exists, the same handoff
desktop tools use. Stop, lease loss and the end of the generation interrupt the wait, and
its finalizer removes the entry, so a late Allow finds nothing. Reads wait two minutes,
changes ten. Deny, timeout and refusal return a model-visible result marked `refused`;
nothing ran. The list of waiting calls is in memory and announced by
`integration.approval.changed`; the card and the off-route toast both read it, never poll.

## Schedules decide in advance

A schedule stores `integration_grants` (read, or read and write, per integration). Only the
editor sets them; a chat draft leaves them out, which keeps what is saved, because a model
must not grant itself authority. A fire copies them into the generation config, where they
replace the chat's choices entirely and nothing ever waits: anything beyond the grant is
refused to the model. The fire first checks every granted connection and ends the run as an
error when one is gone, the way a lost collection does. A person retrying that answer later
is present again, so a retry carries no grants.

## Knowledge sources

A `knowledge_sources` row mirrors one part of an integration into a collection: its root,
an Outline collection or any page in it. A collection may hold any number of sources, the
same Outline collection more than once. A root is `all` (everything under it) or `selected`
(only what is picked), plus page rules that include or exclude; the nearest rule on a page or
its ancestors wins, else the root's mode. Rules name pages, never lists of pages, so a page
added later follows the choice made above it. The sync runs as the collection owner with whatever connection the
owner has when it runs; a source never names a connection row. Disconnecting pauses it and
keeps what it synced, and reconnecting makes the owner's sources due at once. Everyone the collection is shared with can then read what the owner
selected, even without access at the source; this is accepted.

Overlapping sources never index one page twice. A source skips a page another source of the
same collection already mirrors and counts it, and when that source lets the page go, the
next sync of the other one takes it. That rule needs to see the stored state, so the claim
runs at most one source per collection at a time.

Syncs are incremental. The adapter contract takes a `since`: an adapter lists every live
document (that is what makes deletions visible) but may leave out bodies and change times of
documents unchanged since then, and one that cannot tell simply reports everything. Outline
fetches its text-free navigation tree every time for membership, and a newest-first
listing that stops at `since` for content. The cursor is the newest change time the service
itself reported, so neither clock has to agree with the other, read back with a five-minute
overlap for pages saved mid-listing. A selection edit clears it, and a full listing still
runs daily.

The sync is claimed like schedules: due by database clock, `SKIP LOCKED`, a lease, and the
next sync set inside the claim, so downtime collapses into one sync. Changed documents go
through the ordinary note path, which versions, dedupes an unchanged body and indexes it.
Each sync compares against the source's full current listing, so a page deleted,
archived or unpublished there, or moved out of the selection, is deleted here through the
knowledge repo. A root the service answers 404 or 403 for is treated as empty: its pages go,
and the source says which root to drop. Removing the source removes everything it brought. Pages over the note limit, or past the collection's document limit,
are counted on the source, not failed. An oversized page is remembered with its change time
so it is not downloaded again until it changes, and while the collection is full no new page
is fetched at all. Readers of a shared collection see its sources, read-only. A lost or refused connection records the error and
keeps what was synced. Mirrored documents are read-only here: the knowledge service refuses
to edit, replace or delete them, since the next sync would undo it.

Integration citations are their own source kind. They carry a link for the reader but grant
no web-URL authority: `read_url` would only reach the service's sign-in page.
