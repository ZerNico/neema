# Notifications and recovery

Database rows are authoritative. Postgres `chat_sync` notifications carry small
invalidation hints, never chunks, document bodies or execution authority. User
and global envelopes feed authenticated browser sync; an internal envelope feeds
research and indexing only. Internal envelopes never enter browser subscriptions.

State-dependent wakeups use `notifyOnCommit` on the Drizzle transaction's writer
connection. The Effect Postgres adapter's `notify` acquires another connection,
so invoking it inside a transaction does not bind delivery to that commit. Keep
ordinary postcommit publications distinct from transactional wakeups.

The listener owns one `pg.Client` using the shared Postgres configuration. The
installed Effect adapter silently ignores listen-client socket errors; the owned
connection instead fails on error/end and reconnects with backoff. Initial layer
readiness waits for LISTEN, and each successful reconnect announces readiness.
TCP keepalive detects broken connections; SSE heartbeats keep browser streams
alive but do not prove database listener health.

Notifications are not durable. Consumers subscribe before their initial read and
reconcile on readiness after a transport gap. A sequence gap in the bounded local
relay also announces readiness, rather than silently stranding a slow consumer.
Coalesced wakeups retain one dirty flag during a read or queue drain. Research
replays durable ordered chunks; desktop and approval refetch authorized state.
Browser recovery invalidates document details and lists as well as conversations.
Knowledge additionally retains sparse recovery because time alone expires leases.

Chat finalization commits the terminal message, attempt ledger row and conversation
activity timestamp in one fenced transaction. A failed write rolls all three back,
so error finalization can still own the streaming row. Completion is published only
after that commit. Replay checks generation identity both before and after reading
chunks: retry replaces identity and chunks atomically, so a changed identity means
the replay must be discarded rather than labeled with the old generation.

`/api/sync` remains restricted to approved sessions. Pending and rejected accounts
use `/api/approval`, which authenticates the session and exposes only content-free
wakeups for that account's approval or listener readiness. Its initial frame is
sent after subscribing, closing the decision-before-subscribe race. The approval
query determines the new status; approval and sign-out replace the document so a
previous identity's query cache cannot carry into the app.
