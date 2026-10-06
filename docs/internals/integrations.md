# Integrations

An integration lets a person's own account in another service (Outline, Outlook)
reach chat as tools and reach knowledge as a synced source. It is the first feature here that carries real
authority into a chat: every call runs as the sender with credentials they supplied. Most of
the design follows from keeping that authority tied to the person and asking before it
changes anything.

## Manifest and adapter

Each integration is two halves with one id. The **manifest** (`<id>/manifest.ts`,
client-safe) is everything a screen needs: name, logo, admin fields, auth methods, the tool
definitions, the allowances and whether it can be a knowledge source. Each tool is defined once
(`defineIntegrationTool`, in `<id>/tools.ts`): name, title, label, model description,
access class, parameters and a one-line argument summary. The **adapter**
(`<id>/server/adapter.ts`) is behaviour: config normalization, OAuth endpoints, `verify`, one
handler per tool definition, and the knowledge browse, enumerate and fetch.
`integrationHandlers` types each handler by its definition's parameters, so a missing, extra
or mistyped handler does not compile; past that one function the handlers are erased for
dynamic dispatch, which is safe because the toolkit decodes every call against the same
definition first. Admin, Settings, the composer, tool rows, approvals and the source picker
render from the manifest alone, so a new integration is one manifest and one adapter.

A handler does not run a call, it **prepares** one: it checks the arguments, reads from the
service whatever the call will touch, and returns a summary for the approval card with an
`execute` effect, and, for a call that would contact people, its **reach**: the
allowance it falls under and the exact addresses, read from the service where the call names
a stored item. Approval decides on that prepared call and the same one executes, so what
a person approved is what runs, never a second read made after the wait. What a result
means is stated, not guessed: a source says whether it was read in full, and a write names
the page it produced as `link`.

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
- An API key is whatever the manifest's `apiKey.fields` declare, not one string: some
  services want the account's email beside the token. `readFields` checks the values by
  kind and drops undeclared keys before `verify` sees them, and the connection stores those
  values. Adapters receive a `Credential` (an OAuth access token or those values) and alone
  decide how the service wants it sent. A stored document this version cannot decode reads
  as `needs_reauth`, so changing the stored shape costs a reconnect, never a crash.
- A manifest may declare a `scope` (Jira: projects), and a person may limit their
  connection to some of its items. The limit is stored as the choice plus the items: null is
  everything, and an empty list is a limit that reaches nothing, so a selected project
  deleted later narrows the connection instead of widening it back to all. Every chat, agent and schedule using the connection
  stays inside it; agents and schedules cannot narrow it further yet. Only the adapter knows
  where a call lands, so the work is split: reads are narrowed by the adapter (a filter in
  the query, then a filter on what comes back, so a query that escapes its parentheses still
  returns nothing), and every prepared change names the items it touches, read from the
  service, which the tool layer checks against the limit before approval and again after
  the wait. A change that names nothing is refused, so a forgotten declaration fails closed.
  The session reads the limit per call, so narrowing it applies to an answer already running.
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
installed agent's attachments decide, otherwise the connection's "Turn on in new chats". A
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
A destructive call is the exception: only an explicit "allow" in Settings runs it unasked, a
one-off approval cannot, and a scheduled run never does unless an allowance covers it.
A call with a non-empty reach is destructive whatever its tool declares (`effectiveAccess`),
because a message that left cannot be taken back: an event without attendees is a plain
write, the same event inviting people is not. That effective access is what the approval
card, "Always allow in this chat", the streamed and stored tool row, reload and branch all
see. Settings lists tools under an allowance as their own group, so allowing every change at
once does not also let mail go out unasked; allowing that group does.
Consent is checked both before an approval wait and immediately before execution; an
approval cannot override a newly blocked or unavailable integration. Execution also resolves
the current connection and requires the same connection row as the offer. A newly required
approval cannot be silently skipped by a call that was offered as allowed. Credential refresh
checks availability again, without treating an admin disable as bad credentials.

Cheap checks run before preparing: a blocked tool or a scheduled run without the grant is
refused without touching the service, and a malformed call is explained without asking
anyone. Whom a call reaches is known only once prepared, so `consentFor` decides again with
the reach. It returns the reason with a refusal (blocked, beyond the grant, destructive while
unattended, no such allowance, or the addresses outside it), and the tool layer turns it into
what the model reads, naming the addresses that were refused. The
approval card shows the prepared summary when the handler gave one, else the definition's
summary of the arguments: Outline's delete shows the page title and how many nested pages
go with it, never just the id the model passed. A preparation that fails fails the call, as
running it would have. Outline's delete only moves to the trash, so a mistaken approval can
be undone there.

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

An integration may declare **allowances** in its manifest: a way some calls reach people,
the tools that do it, the kind of target and a cap per run. Outlook has two, "Send
mail" (`send_mail`) and "Invite people" (`create_event` with attendees), kept apart so
permission to send a report never also lets a run fill calendars. A grant with write access
may carry, per allowance, a list of exact addresses (at most 20). A scheduled call that
reaches people runs only when every address it would contact is on that allowance's list;
otherwise it is refused, never asked. Grant and payload pass through one parser
(`mailbox.ts`): bare addresses only, display-name forms and lists refused, lowercased, the
domain in IDNA, no `*`. An address is authorized as written: when it is a distribution list,
everyone on it is reached, and that is the owner's choice. The owner's own address counts
like any other.

Checked equals sent. For a saved draft (including replies, whose recipients Outlook fills
in), preparing reads the draft's To and Cc from the service, not from the model's arguments,
and refuses a draft with Bcc: Bcc is never sent from here. Executing first writes exactly the
checked To and Cc back with Bcc emptied, then sends the draft by id, so attachments and
threading stay and a recipient added in the meantime is dropped. Changing calls on one
connection run one at a time within an answer, so nothing edits the draft between the two.

The cap is counted in `integration_allowance_uses`, keyed by the answer's message, by one
insert-or-increment that only succeeds below the cap, taken right before the call goes out.
Parallel calls in one round cannot overshoot it, and a resumed answer cannot start over. A
use goes back only when the call certainly sent nothing (the adapter refused it, or the
service rejected the request with a 4xx other than 408 or 429); a timeout or a server error
may have sent it, so the use stays spent. Sends are not retried except on 429, which means
the request was not processed.

## Outlook

Mail and calendar through Microsoft Graph with delegated permissions (`offline_access
User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite`), OAuth only. It is scoped to
Outlook on purpose: another Microsoft service such as SharePoint becomes its own
integration, with its own id, connection, scopes and tool permissions, even though a person
signs in with the same account. One integration per service keeps what a connection may
touch, and what disconnecting removes, as narrow as its name. The admin's tenant
field (default `organizations`) is the connections' fingerprint, so changing it asks
everyone to reconnect. Graph is a fixed origin and redirects are refused. Entra rotates
refresh tokens; the refresh path stores whichever one comes back. Times without an offset
are UTC on the way in, never the server's zone; a list or availability view returns times in
the zone the model asks for.

## Jira

Jira Cloud only (`*.atlassian.net`); Data Center has another API and its own sign-in, so
it would be its own integration. The admin's site is the fingerprint and pins every request
to Atlassian, so no address exemption is needed. The two ways in take different routes: an
OAuth token only works through Atlassian's gateway, `api.atlassian.com/ex/jira/<cloud id>`,
where the cloud id comes from the token's accessible resources matched to the configured
site (a person who picked another site at consent is told so); an API token is sent with its
account's email as Basic auth, straight to the site, and must be one without scopes.
Descriptions and comments are Atlassian Document Format: the model writes Markdown,
converted to ADF in the tree Jira validates, and reads ADF back as Markdown.

Names the model gives (a person, a transition, a link wording) are resolved during prepare,
so an approval names the real person and status and the call runs with ids. Jira's issue
link endpoint is the reverse of its wording: the issue sent as `inwardIssue` is the one
shown with the outward words ("A blocks B" sends A as `inwardIssue`). Jira has no
allowances: its changes stay inside the team's site, and the notifications they cause are
Jira's own, as with Outline.

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
