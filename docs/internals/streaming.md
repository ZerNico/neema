# Resumable streams

An answer is generated **detached from the HTTP request**, in the Effect runtime
(`StreamEngine`). Its deltas are numbered by `seq`, batched into `message_chunks` and
published to an in-process PubSub. A client reads them over SSE at
`GET /api/messages/:id/stream?after=<seq>`. The server subscribes to live events
first, then replays the persisted chunks after `seq` from Postgres, then switches to
the live tail, dropping anything it already sent, and ends with a terminal `done`
event. Subscribing before replaying is what closes the gap a chunk could otherwise
fall into.

So a reload, a second tab or another browser joins a running answer where it is. The
conversation loader ships the chunks persisted so far inline, so the first paint is
already complete.

Everything else that changes, such as a renamed chat or a new message, reaches other
tabs and instances through the sync bus, described in
[notifications and recovery](sync.md).
