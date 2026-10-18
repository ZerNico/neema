# This instance as an MCP server

Apps like Claude Desktop, Claude Code or Cursor can add this instance as a remote MCP server
at `/api/mcp`. Such an app is a **connected app**: one person's OAuth grant to one client,
listed and revoked in Settings, never an [integration](integrations.md), which runs the
other way. [MCP](mcp.md) covers the client side, this page the server side.

Tokens are bound to `PUBLIC_URL`, and OAuth requires HTTPS off loopback. Without such an
address there is no MCP server at all: the provider throws while the auth instance is built,
which would end every sign-in, so it is left out rather than misconfigured.

## One authorization server, inside the auth instance

`@better-auth/mcp` is the OAuth provider configured for MCP: it binds tokens to the
endpoint's URL and serves both discovery documents. A `/.well-known/*` route hands those
requests to the auth handler, because clients look for them at the origin's root. Registration
is by client ID metadata document (`@better-auth/cimd`), which the 2026-07-28 revision
expects, and dynamically for older clients, with the application type inferred because
some omit it and "web" would refuse their loopback redirects. Registration is open to
anyone and rate-limited, never pruned: an app keeps its client id across disconnects, and a
deleted one would greet its next connect with an error page. Only the code and refresh
grants exist, so every token acts for a person.

Metadata documents are fetched through `fetchPinned`, which resolves once, refuses private
addresses and never follows a redirect: the transport contract the CIMD plugin requires. One
deadline covers the lookup, the answer and its body.

The provider and its plugins are pinned exactly with `better-auth`, as one set. Their tables
live in `src/db/schema/auth.ts` with the rest of Better Auth's.

## Opaque tokens, checked in-process

Access tokens are opaque and resolved through the provider in our own process, by a
server-only endpoint of the `mcp-access` plugin. JWTs would need the server to fetch its own
JWKS from its public URL, which fails behind NAT hairpins, and could not be revoked before
they expire. Opaque tokens cost a lookup per request and end the moment their row does.

Every request then checks what the provider does not:

- **Audience.** The provider can report an active token with no audience, and the gate demands
  the endpoint's URL. Bearer header only: a cookie session never authenticates here.
- **The person, now.** Approval, ban and the `mcp` capability are read on each request, so
  losing any of them ends access on the next call. The answer is a 401, which sends the app
  back to authorize. There a stored consent would mint a code the gate then refuses, forever,
  so a refused person is sent to the consent page regardless, which says why.
- **Sender binding.** A DPoP-bound token is refused: the gate checks no proofs, and accepting
  it as a bearer token would quietly drop the binding.
- **Origin.** An `Origin`, when sent, must equal the public origin exactly, scheme and port
  included. Apps call from their own process and send none, while a page reached by DNS rebinding
  sends its own.

## A grant outlives the browser that gave it

The provider stamps tokens with the browser session that consented, treats a token as dead
once that session expires, and copies the session id onto every refreshed token. A grant
would then die a week after the person last opened the browser. A trigger keeps
`session_id` null on every OAuth token, so a grant lasts until it is revoked or its refresh
token lapses, like a desktop session. The trigger rather than a hook after the token request:
it holds for every write, races nothing, and costs nothing per request.

The price is that ending browser sessions, even every one of them, leaves connected apps
connected. They are disconnected in Settings. Disconnecting deletes the consent, every token
and any code not yet exchanged, since the provider exchanges a code without asking whether
consent survives.

## API keys are grants without a browser

A key is for what cannot do OAuth: another model API's MCP connector, a script, CI. It is our
own table, not Better Auth's API key plugin, which brings endpoints of its own, can turn a key
into a full session, and rate-limits by default; the gate already had one seam a key could feed.
A key secret goes to the key table and never to the OAuth provider, nor a token to the table.
What it yields is shaped like a token's grant, client id `key:<id>`, so nothing past the gate
tells them apart: scopes, request state, provenance ("via n8n (API key)") and edits as the
person all hold as they are.

- **Only a hash is kept.** The secret is 256 random bits behind the `nma_` prefix that secret
  scanners can match, so SHA-256 is as strong as a slow hash and lets a request find its row.
  The secret is shown once.
- **Checked like a token, and more.** Expiry is judged by the database clock, and the
  `apiKeys` capability is read on every request on top of everything a token is held to, so an
  admin can allow connected apps but not long-lived keys. The grant itself claims a minute: the
  SDK refuses a token with no end and would judge a real end by this process's clock.
- **Scopes are the MCP scopes.** Anything that later takes a key checks those same scopes,
  so a key made now keeps meaning what its maker ticked.

## The router must not touch a signed query

The provider sends the browser to the login and consent pages with a query it signed,
including repeated parameters. The router parses search and writes it back with repeated keys
as one JSON array, which breaks the signature (and would change an app's `state` that looks
like a number). So `/oauth/sign-in` and `/oauth/consent` are server routes that read the raw
request and redirect into pages carrying the query as one base64url value.

Signing in does not carry the signature at all. Every way of signing in, social and OIDC
included, already returns to a `redirect` path, so the person goes through `/login` and back,
and the page asks the authorization server again with a session: what the app asked for in the
first place. The provider sends someone already signed in there only when the app asked for a
newer sign-in (`prompt=login`, an expired `max_age`), so that browser session ends first.
Asking again with it would satisfy a request it was too old for. Only a query the provider
signed ends it: the page is a plain GET, so an unsigned link from any site could sign the
person out. Consent posts the exact
signed query back, and the provider checks it.

## Scopes

An app asks for everything by default and the person narrows it at consent. Scopes are read
and write per area (chats, knowledge, documents, memory, skills), plus `offline_access` for
refresh. A request is answered by a server built for its grant, so tools outside the granted
scopes are not listed, and each tool runs only for a token holding its scope. Tools reach
services through a runner the route passes in, the app runtime in production.

## The person's library over MCP

Each area goes through the service its own page uses, so access, capabilities and limits are
the app's. Where a page leans on not being shown, the tool asks the question itself: memory's
manual writes check the person but not the instance's switch, since the settings page appears
only when memory is on.

- **Documents are written as the person.** An app's edit is the person's own, made through
  their app: steps are stored with origin `user` and a client id naming the app, so the chat's
  model reads it as "the person edited since you read", which is true. It needs no generation,
  but it is held to the model's rule, not the editor's. A replace or delete covers only blocks
  the read showed as they still are; `seen`, the read's block fingerprints as one opaque value,
  grows as the document is read on piece by piece, and forging it could only claim this person's
  own document was seen. A block longer than one piece is never seen whole, as for the chat's
  model, so only `find` changes it. `find` rests on no read: it replaces exactly the text it
  names and only the part that differs. Text under open comments is never removed from outside
  the app. Apps create documents in projects only: a chat's documents belong to the answers
  that made them, and one made from outside would hang off whichever answer came last.
- **Skills are prompts, and their files are read on demand.** A grant to read skills lists every
  skill the person may read as a prompt, the manual-only ones included, since picking a prompt is
  as deliberate as pinning a skill; `list_skills`, which the outside app's model reads unasked,
  leaves those out. They are read when prompts are asked for, never on other requests, and each
  is resolved again by id when fetched, so a skill unshared since gives nothing. A name another
  skill also takes becomes the skill's id. The built-ins are not stored skills and drive this
  app's own tools, so they are not offered.

## Chats over MCP

An app sends as the person, through the same `sendMessage` the composer uses: one way in,
so retry, edit, queue and every rule of an attempt stay as they are. What the browser would
send, the tool fills in: the model named, else the chat's, the agent's, then the default.
Search follows the composer too: on unless the chat's agent says otherwise, and left out when
this account or instance cannot search, unless the app asked for it. A continued chat keeps
its agent, so its defaults apply to every send.

- **Provenance.** The user message records the app that sent it, by client id and by name
  as it was, since the client may be deleted. It never changes, a branch copies it, and the
  chat shows "via Claude" under it. Nothing else differs: an MCP chat is an ordinary chat.
- **Accepting is uninterruptible.** Creating the turn and starting its answer run as one
  piece, or a client dropping the request in between would leave a streaming row nobody
  started.
- **Waiting is not owning.** The tool follows the answer's live tail and returns when it
  ends, when a retry in the app replaces it, or after its wait (45 seconds by default, under
  the minute clients give a request). Then the app gets `running` and asks again with
  `get_message`. Cancelling a request stops the waiting, never the answer, as closing a tab
  does. Only `stop_generation` stops it, and only the attempt it names.
- **Answers are read by attempt.** A retry in the app between two calls must not hand back
  its answer under the old attempt's id, so the tool reports `superseded` instead, also when
  the retry lands between the reads one answer takes.
- **Clarifying questions go to the calling app.** It delegated the work and knows why, so
  `ask_user` stays offered. The turn ends with the questions, and the app replies with
  `answer` naming the call, the same structured answer the chat's own card sends. Whether a
  question is open is decided by the rule that accepts the answer, never a copy of it, and the
  card in the app says which app answered.
- **Reading a chat is the chat view's read.** `read_chat` pages by turn from the window the
  detail loader uses, reaps a lapsed answer first, and reads again when an attempt changed under
  it, so a page never mixes two. Text still being written may differ between reads; waiting for
  it to settle would hold the read for the whole answer. Citation numbers are the chat's, so an
  answer's footnotes resolve against the sources registered up to it, earlier pages included,
  never a later answer's. The structured result carries each message's own text, so who said
  what never rests on headings a quoted page could imitate. A `ui` block stays as source behind
  a note, since the data the prose points to often lives only there; links into this instance
  are made absolute outside such blocks.
- **A Work chat is read, never continued.** Its next answer needs the desktop app that runs
  its machine tools, so a send or retry over MCP is refused as one without a desktop executor
  is in the app. Listings mark it, so an app need not learn this by being refused.
- **Retry, branch, keep, archive, rename are the app's own.** Each goes through the service
  call the chat view makes. A retry over MCP rewinds as one in the app does and is accepted as
  uninterruptibly as a send. It is not attributed: provenance belongs to the person's message,
  which a retry keeps. A temporary chat is never archived; it is kept first or swept.
- **Files ride in the call, measured before they are read.** `send_message` takes files as
  base64 in its arguments. The server caps the request body before parsing it (one file's worth
  above the SDK's default), and each file's size is read from its text before anything is
  decoded. They are stored through the composer's own upload, under the same `attachments`
  capability, typed by their bytes. One refused file stores none, and a send that is refused
  removes them, as closing the composer would. An answer's own files go back as
  `resource_link`s to `chat://attachments/{id}`, read through `resources/read` with the access
  check that serves them in the app, so a link names nothing its holder could not open there.
- **A person's decisions go to the app's person.** When an answer parks on an integration
  approval or a service's question, the watching call ends with `input_required`: the same
  approval the card shows, as a form the client puts to its person. The turn is sealed into
  the request state (HMAC under a key derived from `ENCRYPTION_KEY`), with each entry's nonce,
  and the call that comes back with the answers settles them and follows that turn. It never
  reads its arguments again, so a re-sent `send_message` cannot start a second turn. Elicitation
  is client UI addressed to the person, so we trust the client to show it, as we trust it with
  the token; approvals are a net against careless changes, not a boundary against the app. The
  in-app card stays live and the first answer wins.
- **Who cannot ask gets `needs_person`.** A grant that may only read, a client that declared
  neither forms nor pages for a call, and every 2025-era client get the waiting calls and the
  chat's link instead: per-request serving cannot carry a server's request to the client and
  back. `get_message` waits past what is already waiting that it cannot ask about, and wakes for
  anything new, so an app polling it does not spin on one approval. Asking is bound to the
  attempt followed: a call following one a retry replaced asks nothing and settles nothing.
- **State outlives every wait, and answers need it.** The sealed state is valid for an hour,
  well past any approval: a late answer settles nothing (the entry is gone or carries a newer
  nonce) and is reported as late, while an expired state would leave the app an error with no
  messageId and re-sending its message as the obvious next step. Answers arriving without any
  state are refused rather than running the call's arguments again.
