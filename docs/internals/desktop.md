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

Browser and Electron load the same SPA. The document shell owns a permanent
native-control row and portal target, revealed before paint only on capable
shells. The row is at least 48px high, including unauthenticated and route-error
screens. Live desktop UI mounts inside a client-only boundary, so hydration does
not first present browser defaults. Authenticated header controls portal into
the existing target without moving their providers. Sidebar and viewport-height content
reserve the row once; native-control clearance uses overlay geometry with platform
fallbacks. Interactive controls are not draggable. Native fullscreen keeps the app
row but releases unused button gutters. Browsers and older shells retain the
original layout; an updated shell needs the updated site for integrated layout.
Linux decoration still depends on the desktop/window manager.

Connection and initial-load recovery are bundled local pages with their own drag
strips. Their preloads expose no Work surface, and local actions require the exact
bundled document, window and main frame. Recovery can retry only the configured
server. Aborted/subframe failures are ignored, and an established Work renderer
is not replaced merely because later network activity fails.

The server chooser is not only a first-run screen. The app, dock and tray menus,
the recovery page and the site (sign-in screen, account menu, through the `auth`
capability) can all reopen it, and each of them can only ask: the address is
typed in the chooser, never sent by a page, so a compromised site cannot point the
bridge at another origin. Connecting writes the config, replaces the main window
with one for the new origin and destroys the chooser; cancelling the chooser
while a main window exists just closes it. Local work belongs to the server that
started it, so opening the chooser or confirming a new address while Work is
active asks first, with the same wording family as Quit, and disposes
executions and owned processes only after a yes. A chooser opened while idle
does not skip that question if work starts before connect. Draft folder grants
are forgotten with that dispose, so the next server does not inherit the
previous compose-time folders; durable conversation mappings stay on the
machine. `CHAT_DESKTOP_SERVER` pins the server for development: main tells every
preload through a process argument, the site and recovery page then show no
switch at all, the menu item is absent, and the IPC still refuses as a backstop.
`connect-flow.ts` holds this logic electron-free. During dev reload,
`CHAT_DESKTOP_PROFILE` selects userData before services or sessions open; the root
dev runner supplies a checkout-local directory. The installed profile is unchanged.
See [development isolation](development.md).

## Sign-in happens in the browser

The shell never shows a password form. Google refuses OAuth from an embedded
user agent, and the person's provider session lives in their real browser, so
the login route renders a browser-only screen whenever the shell exposes the
`auth` capability: a link to `/desktop/sign-in?challenge=…` that the window-open
handler pushes to the system browser, and a paste field for the code that page
mints. The browser page mints a ticket only for a signed-in, approved, not
impersonated account, and shows it twice: as a `chat-desktop://sign-in` link
and as a `XXXXX-XXXXX-XXXXX-XXXXX` code. The link is never fired automatically,
because macOS has no scheme registered until the app is packaged and a silent
failure would leave nothing to paste. Windows and Linux register the scheme at
runtime; the deep link is otherwise dormant.

A ticket lives three minutes, is stored hashed in Better Auth's `verification`
table, and is consumed once; every failure is the same "not valid" answer.
The shell's login page keeps a PKCE verifier in `sessionStorage` and sends its
S256 challenge with the link, so a ticket minted with a challenge is refused
without the matching verifier. Settings › Devices mints paste-only tickets
without a challenge, which the redemption accepts with no verifier at all.

A deep-linked ticket only fills the code field; the person presses Continue.
Anyone can open `chat-desktop://sign-in?ticket=…`, and a paste-only ticket has
no challenge for the verifier to check, so a shell that redeemed on arrival
could be signed into whichever account minted the ticket. The click is the
consent the verifier cannot supply for that path.

Redemption creates a separate session for the desktop, ninety days long,
and the shell renews it to a fresh ninety days on every authenticated mount
through `/desktop/session/refresh`; Better Auth's own late refresh (from day
84) would otherwise re-set the cookie to the browser's seven days. Refresh
keys on the **stored** session user agent from redemption, not the request
header. That gate is a convenience, not a boundary: any authenticated
browser can mint and redeem a ticket and hold a 90-day session that way.
The Devices label "Chat Desktop on …" reads that same stored token. Revoking
either session leaves the other valid. After redeeming, the page does what
`IdentityBoundary` does on an identity change: clear the query cache and
replace the document.

Off-origin navigation and `window.open` from the shell are handed to the OS
only for `http:` and `https:`. Other schemes are dropped rather than passed to
`openExternal`. Sign-in tickets are delivered only to a loaded page of the
configured origin; recovery and connect documents never receive them. Main
holds one undelivered ticket until that page's frame has loaded (a later deep
link replaces it); the preload then holds it until the login screen subscribes,
because the frame loads before the SPA mounts its listener. Windows and Linux
deliver the link as an argument, of a second instance when the app is running
and of `process.argv` on a cold start; both are read.

## Execution belongs to the authenticated app, not a chat route

`DesktopWorkProvider` lives inside `IdentityBoundary`, above the route outlet.
It therefore sits above the fixed sidebar and renders no chrome itself: the
unreachable-server notice is a separate context consumer the layout places in
the content column, under the header. Because no poll can disprove a failure,
one schedules its own snapshot refetch on a bounded backoff and on `online`
and `focus`, and any answered request clears it, not only a delivered result.
The notice needs the last successful snapshot to have held attempts or calls,
so a blip with nothing running, or before any snapshot arrived, stays silent.
Its controller watches the authenticated Work snapshot, refreshed by id-only
sync notifications, initial subscription readiness and reconnect reconciliation.
Conversation policy/title changes and terminal message events refresh it too;
there is no periodic snapshot fetch. The engine's ten-second maintenance cancels
stale tracked attempts independently of snapshot reads. Message SSE is for display,
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
The registration and handler share that deadline, and it starts at
registration, before anyone has approved. The desktop's own command timeout
is therefore derived from what is left of it when execution starts, minus a
delivery margin, never a fixed ten minutes of its own: a command either
finishes inside the wait that will accept its result or is stopped, and is
not started at all when approval came too late. Expired or terminal calls
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

Every model-operation RPC includes its call ID, including reads. The schema
requires it; a missing id is refused before the handler runs. Main keys
in-flight work by call ID and RPC tag, so a renderer that reloads mid-call
joins the operation its predecessor started instead of starting a second one.
A finished side effect (write, edit, move, delete, command) is retained for
ten minutes, the longest the server would still accept its result, and a
replay in that window gets the answer rather than a second execution; a
finished read is dropped at once, since reading twice costs nothing and the
result may be large. A cancellation is remembered for the same window so a
request arriving after its Stop is refused, not started. Nothing is keyed on
payload content: the page is the configured origin's, and a hostile page
would simply mint a new id. None of this persists through an app crash. A
new main process has a new execution session and cannot silently replay an
old attempt.

The renderer retains a completed result while retrying failed delivery. It does
not repeat the filesystem operation merely because the HTTP reply was lost.
Claim and delivery failures schedule their own exponential retry, capped at ten
seconds and the call deadline. Snapshot refreshes cannot bypass backoff. An
acknowledged result stops delivery; refusal, removal, expiry and identity teardown
cancel retries. This retry is failure recovery, not snapshot polling.
Before the first send, a dispatch barrier is installed for that create. Until
the create response names the conversation, any local call waits, because the
destination id is not known yet. After that, only calls for the new conversation
wait through rebind; other conversations are not stalled. The barrier is
released after rebinding has been attempted. A failed or interrupted rebind
does not authorize guessing a path. The create itself has already committed, so
the first send still navigates; the destination simply has no grant until the
person attaches again.

Mode and research on a first send are sampled at Submit, not after queued
uploads settle. Draft text and skill chips stay live through that wait.

## Mode is fixed; capabilities are current

`conversations.mode` is `chat | work`, fixed at creation and inherited by a
branch, along with that chat's permission level. Work needs the desktop app,
not a folder. Send, retry, edit and structured
answers all submit current desktop capabilities and executor identity. Work
attempts without them are refused before rows are created or reset. Retry never
revives an old attached-folder or command setting. Plain chat ignores local-tool
capability fields. Browser Work history remains readable, with continuation
actions disabled and server policy enforced independently.

The server stores folder names per attempt (`desktop_folders`, an array),
never paths. `folders.json` maps server origin plus conversation to local
grants: ids are minted by the server the shell is connected to, so two servers
can issue the same one, and a grant on one must not open the folder to the
other. Writes are serialized and replaced by an atomic rename, so overlapping
attach/detach cannot resurrect a detached folder after restart. Losing the
file remains a supported outcome: every conversation asks again. The composer strip and submission share a
conversation-keyed local query, cleared with the authenticated identity cache.
On capable desktops, route loaders prepare Work conversation and draft folder
state before the composer mounts. The hook consumes that cache without an immediate
mount refetch or automatic retry. A failed first read opens the conversation with
an inline folder retry, not a route error or empty grants. A later refetch that
fails keeps the last successful status, so a blip on focus does not look like a
missing folder or block send. Ready-empty is valid: a new
machine can continue Work without file tools until folders are attached there.
Folder loading and mutation state block new attempts without opening a second,
animated warning inside the input. ChatView and NewChatView share that gate
through `useWorkGate`; the composer is told `readOnly` rather than computing
it again. Focus refresh does not remount the host.

Loader preparation holds a query observer so unmounting the outgoing composer for
route pending UI cannot cancel the read the destination still needs. It respects
explicit cancellation, pending folder mutations and draft rebinding. Mutations
cancel older reads and update only their original cache entry; draft rebinding
invalidates both draft and destination state before releasing dispatch. Local
queries are neither server-rendered nor persisted in the web backend.

## Several folders, one file-tool address space

A model file path begins with an attached folder's basename, such as
`site/src/index.ts`; `list_folder "."` lists the folders. Duplicate basenames are
refused at choose and at rebind. A lost folder can be replaced by name from
Choose it again. `find_files` names a matching folder and the files inside it,
not only files whose own names match. `find_files` and `search_files` share the
same glob address space: a pattern that starts with an attached folder name is
scoped to that folder. This is a virtual address space for file tools, not a
shell mount layout.
`run_command` separately names its working folder. The shell sees real filesystem
paths relative to that cwd; `other-folder/file` does not automatically resolve to
another attached folder. Attached roots are writable under the command's sandbox
policy, but are not remapped into virtual shell paths.

The two spaces contradict each other, so the system hint and the `run_command`
description both spell out that a command leaves its folder's name out of its
paths. Told only the file-tool rule, a model writes `cd site && python
site/main.py`, which fails on both halves and costs two turns to learn.

## Containment and command isolation

File paths pass through `resolveAcross` and `resolveInFolder`. Absolute paths are
refused, existing ancestors are inspected with `lstat`, and `realpath` establishes
containment. A dangling symlink is not treated as an absent ordinary path: its
resolution fails closed. Refusals name the path the caller supplied, never a
host absolute. Only `ENOENT` allows walking to a parent. Moves check
both ends. This does not claim protection against every concurrent filesystem
replacement or hard-link alias.

Commands always use `@anthropic-ai/sandbox-runtime`, with no unsandboxed fallback.
Its manager is one per process with one proxy and one live policy, which is
why network policy is a fact about the machine, set once at initialization,
and not a per-chat choice: two chats wanting different levels would need two
proxies. Commands from different chats run concurrently; only start, reset,
the Windows install and the Linux mount cleanup wait for running commands to
drain. Initialization is marked successful only after it succeeds.

Reads are deny-then-allow in srt, so the home directory is denied as a whole
and a list of toolchain locations (version managers, package stores, caches,
git's identity) is re-allowed inside it, with the few credential files that
sit in those regions denied again. The rest of the disk stays readable. Each
call adds its attached folders to both the read and the write allow lists;
they are the only writable places. A tool installed somewhere unusual fails
with a denial that names the path, which is preferred over a readable
`~/.git-credentials`.

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

The permission level belongs to the conversation; the host refreshes it from
the server. The folder strip is where it is changed: “Approve each action”,
“Auto-approve reads”, or “Auto-approve reads and changes”, with descriptions
in the picker. The stored values remain `manual`, `auto`, and `skip`.

Manual asks for reads too; automatic asks before changes and commands; skip
allows those without another question. The dedicated delete tool always asks,
once per call, and a call may name several paths so a cleanup is one
confirmation rather than one per file. An allowed command can also delete
files; this is not a deletion safeguard. Conversation-scoped
blanket edit grants never cover commands or deletes, and manual reads have no
blanket grant. These decisions outlive route changes but not the authenticated
execution host. Approval cards remain actionable while generation is streaming,
because the handler is waiting rather than finished.

## Results, search and exact edits

Full local file bytes are transient. Text reads and JS search pull a bounded
prefix from disk rather than buffering the whole file; edits refuse a file
larger than a write. Images and PDFs become model file parts where supported,
with server extraction fallback; persisted tool rows and chunks retain only
bounded summaries. The page's result is untrusted: summary, detail and file
bytes are capped and sniffed once, in the server function that accepts them,
before they reach the model or process memory; the generation loop only checks
the shape. Native and Hermes loops share this handling.
Research keeps its existing server-side investigation and synthesis paths; this
change does not add local tools to research workers or move their lifetimes into
the desktop host.

Search uses installed ripgrep when available and the JavaScript walker
otherwise; no additional native binary is bundled, and the handler picks the
backend once per call. Both skip symlink traversal, include hidden files other
than `.git`, and honour `.gitignore` even outside a checkout. They are not
identical: rg also reads `.ignore`, `.rgignore` and repository excludes, gives
a deeper `.gitignore` precedence where the walker ORs them, and has its own
glob and regex dialects. rg runs with `--no-config` so a user's
`RIPGREP_CONFIG_PATH` cannot add `--follow` or `--no-ignore`. Its exit code 2
covers any error, including one unreadable file, so a run that produced a
summary is a partial answer and only a run with none is a failure, with a bad
pattern or glob told apart by rg's message.

Edits require an exact, unique match unless `all` is set. Replacement text is
literal, including dollar-substitution tokens. `diff` supplies a bounded unified
preview; expensive or oversized previews are marked truncated rather than
blocking indefinitely. A preview limit does not change the applied replacement.
