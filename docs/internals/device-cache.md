# Device cache

`modules/cache/client/device-cache.ts` keeps data on the reader's device in IndexedDB for things
worth showing at once on the next visit and cheap to lose. The ui block tree cache is its first
user (see [generative UI](generative-ui.md)); a document's unsent steps are another (see [documents](documents.md)).

- One database (`neema-cache`) with one store holds every cache, keyed `[owner, namespace, key]`.
  A new cache is a new namespace, never a schema version. Each namespace has its own byte budget
  and drops its oldest entries past it.
- Reads come from memory: `warm()` loads a namespace once, then `get` is synchronous, which is what
  lets a component draw cached data on its first frame. Writes are batched a moment later in one
  transaction, and flushed on `pagehide`.
- IndexedDB, not localStorage. localStorage is synchronous on every write and shares one small
  quota with drafts and settings; a cache of rendered trees would both block the page while a
  slider drags and risk making those writes fail.
- It is a cache, never a source of truth. An unavailable or failing IndexedDB (private windows, a
  full disk) leaves a memory-only cache and no error, and nothing may depend on an entry being
  there.
- Entries belong to an identity (user, plus the admin when impersonating). The `_app` route sets
  the owner in `beforeLoad`, before anything renders, so the first frame can read the cache.
  Setting an owner deletes every other owner's entries, and `IdentityBoundary` clears the whole
  store on any identity change, waiting up to half a second for it before replacing the document,
  which would otherwise abort a clear still in flight. A session that ended outside the app therefore leaves nothing
  readable for whoever signs in next on the same browser.
