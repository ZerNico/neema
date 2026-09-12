# Work chats and the desktop shell

The Electron shell loads the deployed site and exposes an origin-checked,
schema-derived bridge. The web application owns authentication; Electron owns
folder grants, sandboxed local execution and native window controls. Absolute
folder paths stay in the desktop profile, not in the server database.

The window uses `hiddenInset` on macOS and `hidden` with Window Controls Overlay
on Windows/Linux, retaining standard controls rather than web replacements.
An optional presentation capability, independent of the Work protocol version,
provides platform, fullscreen state and a validated theme preference. Theme writes
require the same configured origin, main window and main frame as Work calls.
Electron owns the overlay palette and follows the requested light/dark/system
appearance; state and OS appearance changes use events, not polling.

Connection and initial-load recovery are bundled local pages with their own drag
strips. Their preloads expose no Work surface, and local actions require the exact
bundled document, window and main frame. Recovery can retry only the configured
server. Aborted/subframe failures are ignored, and an established Work renderer
is not replaced merely because later network activity fails.

## Execution belongs to the authenticated app, not a chat route

`DesktopWorkProvider` lives inside `IdentityBoundary`, above the route outlet.
Its controller watches the authenticated Work snapshot, refreshed by id-only
sync notifications and background reconciliation. Message SSE is for display,
not execution authority. Opening chat B or settings does not stop chat A, reset
its approvals, or replay its calls. Each conversation has independent consent.
Off-route approvals use the shared Sonner notifications with a Review action,
not a blocking dialog. Each pending call is announced once while it remains
pending; refreshes and dismissal do not repeat it. A persistent approval-count
menu opens any waiting conversation even after its toast is dismissed. Returning
to the conversation dismisses its toast, and resolved requests or host teardown
clear their notifications. Allow and Deny stay in the transcript.

Closing the Electron window hides it, preserving the renderer and its execution
host. Minimizing and backgrounding also leave it running; background throttling
is disabled. The tray, application menu and Dock can reopen the window. Explicit
Quit asks for confirmation when Work is active, then awaits cancellation and
owned-process cleanup. Closing is not quitting. Development rebuilds deliberately
interrupt Work: the supervisor owns the actual Electron binary, requests cleanup
through a private process channel, and waits for the old child to close before
starting another. This path skips the interactive Quit question, not cleanup.
A stalled shutdown is reported before escalation; failure to observe exit refuses
a replacement rather than accumulating desktop instances.

## An attempt owns its local calls

A Work submission carries the current main-process execution session ID. That
ID is random for each app lifetime, not a stored device identifier. The server
binds each active attempt and call to user, conversation, message, generation
and executor. This authority is runtime-only: it is neither copied by branching
nor restored from a saved message configuration.

Before local dispatch, the web host claims the call. Before accepting a result,
the server checks the same tuple and claim token again. Both endpoints check
streaming status and the generation lease using the database clock, then recheck
the in-process registration. An owned conversation alone does not authorize an
unrelated call ID. A second device can observe progress but cannot claim work
started by the first. A server restart loses authority and fails closed.

The initiating session is a binding mechanism, not cryptographic attestation.
`fromDesktop` is caller-supplied policy information. The origin-authorized page
already has bridge authority; page approval is not a hardened boundary against
a compromised authorized page.

## Bounded waits and cancellation

Desktop handlers block on `ExternalCompletion` inside the normal tool loop.
The SDK starts handlers concurrently with consumption of its stream: seeing a
provider call ID does not mean the tool row or external registration exists yet.
A per-turn readiness Deferred releases the handler only after both exist; Stop
or stream failure interrupts the wait. Registration also precedes the public tool
announcement, so a fast result can arrive before the handler starts waiting.
Native and Hermes calls share this handoff and the normal prompt-folding loop.

The wait must have its own deadline: the ordinary generation flusher renews the
lease even when idle. Reads get two minutes; changes and commands get ten.
The registration and handler share that deadline. Expired or terminal calls
cannot be newly claimed. Stop revokes the attempt, and generation scope cleanup
removes authority on completion, failure or interruption.

The host removes stale approvals before applying blanket decisions and rechecks
liveness after asynchronous claims. Navigation never cancels. Stop, deadline,
identity teardown and document teardown cancel pending/queued calls and request
cancellation of running local operations. A document reload can therefore fail
an interrupted call safely rather than resume it. Abrupt renderer loss may leave
an operation in Electron; an identical request can recover its retained result.
Completed filesystem changes cannot be rolled back.

## Replay is bounded, not distributed exactly-once execution

Every model-operation RPC includes its call ID, including reads. Main-process
replay keys include the RPC tag and a canonical payload fingerprint. An identical
request joins the original operation or returns its cached reply; changed payloads
are refused. Separate `readFile` and `readBinary` requests may share one logical
call ID. Cancellation installs a tombstone even before a request arrives.

Replies and tombstones are held in memory for 24 hours, with entry and byte
limits. Capacity refuses admission rather than evicting active work. An oversized
completed reply may become an explicit unavailable-result refusal, never a reason
to rerun the side effect. None of this persists through an app crash. A new main
process has a new execution session and cannot silently replay an old attempt.

The renderer retains a completed result while retrying failed delivery. It does
not repeat the filesystem operation merely because the HTTP reply was lost.
Before the first send, a dispatch barrier is installed; it is released only after
the new conversation's draft-folder rebinding has been attempted. A failed or
interrupted rebind does not authorize guessing a path.

## Mode is fixed; capabilities are current

`conversations.mode` is `chat | work`, fixed at creation and inherited by a
branch. Work needs the desktop app, not a folder. Send, retry, edit and structured
answers all submit current desktop capabilities and executor identity. Work
attempts without them are refused before rows are created or reset. Retry never
revives an old attached-folder or command setting. Plain chat ignores local-tool
capability fields. Browser Work history remains readable, with continuation
actions disabled and server policy enforced independently.

The server stores folder names per attempt, never paths. `folders.json` maps
conversations to local grants. The composer strip and submission share a
conversation-keyed local query, cleared with the authenticated identity cache.
On capable desktops, route loaders prepare Work conversation and draft folder
state before the composer mounts. The hook consumes that cache without an immediate
mount refetch or automatic retry. A failed read opens the conversation with an
inline folder retry, not a route error or empty grants. Ready-empty is valid: a new
machine can continue Work without file tools until folders are attached there.
Folder loading and mutation state block new attempts without opening a second,
animated warning inside the input. Focus refresh does not remount the host.

Loader preparation holds a query observer so unmounting the outgoing composer for
route pending UI cannot cancel the read the destination still needs. It respects
explicit cancellation, pending folder mutations and draft rebinding. Mutations
cancel older reads and update only their original cache entry; draft rebinding
invalidates both draft and destination state before releasing dispatch. Local
queries are neither server-rendered nor persisted in the web backend.

## Several folders, one file-tool address space

A model file path begins with an attached folder's basename, such as
`site/src/index.ts`; `list_folder "."` lists the folders. Duplicate basenames are
refused. This is a virtual address space for file tools, not a shell mount layout.
`run_command` separately names its working folder. The shell sees real filesystem
paths relative to that cwd; `other-folder/file` does not automatically resolve to
another attached folder. Attached roots are writable under the command's sandbox
policy, but are not remapped into virtual shell paths.

## Containment and command isolation

File paths pass through `resolveAcross` and `resolveInFolder`. Absolute paths are
refused, existing ancestors are inspected with `lstat`, and `realpath` establishes
containment. A dangling symlink is not treated as an absent ordinary path: its
resolution fails closed. Only `ENOENT` allows walking to a parent. Moves check
both ends. This does not claim protection against every concurrent filesystem
replacement or hard-link alias.

Commands always use `@anthropic-ai/sandbox-runtime`, with no unsandboxed fallback.
Its proxy reads global mutable network policy, so a semaphore covers the entire
command lifetime: initialization, configuration, preparation, child execution,
and cleanup. A queued command cannot alter a running command's network policy.
Initialization is marked successful only after it succeeds.

On macOS, the wrapper replaces `localhost` in leading sandbox-generated proxy
environment assignments with `127.0.0.1`, avoiding resolver access denied by the
sandbox. It also places the pip cache inside the granted folder. It never rewrites
proxy-looking text inside the user's command.

Owned POSIX process groups are terminated during cancellation and cleanup;
Windows uses `taskkill /T`. Descendants that deliberately escape the process
group, and Windows trees whose root has already exited, are not guaranteed to be
stopped. Windows Job Objects are not implemented. Sandbox preparation must settle
before its policy ownership can be released.

## Policy is server-held; consent is local

Network and permission levels belong to the conversation. The host refreshes
them from the server and sends the network level with commands. The folder strip
shows only the approval level: “Approve each action”, “Auto-approve reads”, or
“Auto-approve reads and changes”, with descriptions in the picker. The stored
values remain `manual`, `auto`, and `skip`. There is no per-chat network picker.

Manual asks for reads too; automatic asks before changes and commands; skip
allows those without another question. The dedicated delete tool always asks,
but an allowed command can also delete files; this is not a deletion safeguard. Conversation-scoped
blanket edit grants never cover commands or deletes, and manual reads have no
blanket grant. These decisions outlive route changes but not the authenticated
execution host. Approval cards remain actionable while generation is streaming,
because the handler is waiting rather than finished.

## Results, search and exact edits

Full local file bytes are transient. Images and PDFs become model file parts
where supported, with server extraction fallback; persisted tool rows and chunks
retain only bounded summaries. Native and Hermes loops share this handling.
Research keeps its existing server-side investigation and synthesis paths; this
change does not add local tools to research workers or move their lifetimes into
the desktop host.

Search uses installed ripgrep when available and the JavaScript walker otherwise;
no additional native binary is bundled. Both paths skip symlink traversal and
apply ignore rules, though engine-specific regular expression differences remain.

Edits require an exact, unique match unless `all` is set. Replacement text is
literal, including dollar-substitution tokens. `diff` supplies a bounded unified
preview; expensive or oversized previews are marked truncated rather than
blocking indefinitely. A preview limit does not change the applied replacement.
