# Work chats and the desktop shell

The Electron shell loads the deployed site and exposes an origin-checked,
schema-derived bridge. The web application owns authentication; Electron owns
folder grants, sandboxed local execution and native window controls. Folder
paths stay out of the server database; they live in the desktop profile and in
attempt-scoped prompt and tool traffic only.

The window uses `hiddenInset` on macOS and `hidden` with Window Controls Overlay
on Windows/Linux, retaining standard controls rather than web replacements.
An optional presentation capability, independent of the Work protocol version,
provides platform, fullscreen state and a validated theme preference. An optional
`browser` capability, also outside the protocol version, names the server's browser
profile and paces embedded pages; see [the embedded browser](browser.md). Theme writes
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
and as a `XXXXX-XXXXX-XXXXX-XXXXX` code. When the shell sent the person there
(a challenge came with it), the page fires the link as soon as the ticket
exists, since the app is waiting; the button and code stay for a browser that
refused. The packaged app declares the scheme through electron-builder, the dev
shell through its renamed copy of Electron.app (`electron-app.mjs`), which also
carries its own bundle id so macOS hands it the link and notification clicks
rather than another project's stock Electron. Windows and Linux register the
scheme at runtime.

A ticket lives three minutes, is stored hashed in Better Auth's `verification`
table, and is consumed once; every failure is the same "not valid" answer.
The shell's login page keeps a PKCE verifier in `sessionStorage` and sends its
S256 challenge with the link, so a ticket minted with a challenge is refused
without the matching verifier. Settings › Devices mints paste-only tickets
without a challenge, which the redemption accepts with no verifier at all.

A deep-linked ticket is redeemed on arrival with `boundOnly`, which succeeds
only for a ticket bound to a challenge: only this shell holds the verifier, so
no other page can produce one it accepts. Anyone can open
`chat-desktop://sign-in?ticket=…` with a paste-only ticket, which has no
challenge to check and could be another account's; `boundOnly` refuses it
before consuming it, and it waits in the code field for Continue. The click is
the consent the verifier cannot supply for that path.

Redemption creates a separate session for the desktop, ninety days long,
and the shell renews it to a fresh ninety days on every authenticated mount
through `/desktop/session/refresh`; Better Auth's own late refresh (from day 84) would otherwise re-set the cookie to the browser's seven days. Refresh
keys on the **stored** session user agent from redemption, not the request
header. That gate is a convenience, not a boundary: any authenticated
browser can mint and redeem a ticket and hold a 90-day session that way.
The Devices label "neema Desktop on …" reads that same stored token. Revoking
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
branch, along with that chat's permission level. Work needs the desktop app and a current [Work grant](feature-policy.md),
not a folder: every work conversation has an app-managed workspace that
materializes on demand, so ready-empty means the workspace is there and empty,
never that the chat is unusable. Send, retry, edit and structured
answers all submit current desktop capabilities and executor identity. Work
attempts without them are refused before rows are created or reset. Retry never
revives an old attached-folder or command setting. Plain chat ignores local-tool
capability fields. Browser Work history remains readable, with continuation
actions disabled and server policy enforced independently.

Each attempt is also stamped with the sending machine's id and display name
(`desktop_machine_id` / `desktop_machine_name` on the generation config). The
id is a per-install UUID the shell keeps in `machine.json`; a reinstall mints a
new one, which is exactly the point: a chat whose latest attempt came from a
machine this install does not know shows a dismissible banner naming it, with
a take-over action that materializes this machine's workspace. Nothing is
copied between machines, and the stamp is attempt metadata, never an address
or a credential.

The server persists folder and workspace-file names per attempt, never paths.
Absolute paths cross it only in the attempt's system hint and desktop tool
traffic, like file contents already do, so a conversation opened on another
machine carries no stale addresses. `folders.json` maps server origin plus
conversation to local grants: ids are minted by the connected server, so two
servers can issue the same one and a grant on one must not open the folder to
the other. Writes are serialized and replaced by an atomic rename, so
concurrent attach and detach cannot resurrect a removed grant after restart.
Losing the file remains supported: every conversation asks again.

The composer strip and submission share a conversation-keyed local query,
cleared with the authenticated identity cache. Route loaders prepare Work
folder state before the composer mounts. The hook consumes that cache without
an immediate mount refetch or automatic retry. A failed first read opens the
conversation with an inline retry rather than a route error or empty grants.
A later failed refetch keeps the last successful status, so a focus-time blip
does not look like a missing folder or block send. Ready-empty is valid: a new
machine has its own empty workspace and can continue Work immediately, with
user folders re-attached only when wanted. Folder loading and mutation state
block new attempts without opening a second animated warning inside the input.
`ChatView` and `NewChatView` share that gate through `useWorkGate`; the composer
receives `readOnly` rather than recomputing it. Focus refresh does not remount
the host.

## The workspace

Beside the granted folders, every Work conversation has a local app-owned
workspace under `<userData>/workspaces/<origin-hash>/<conversation-id>/`. The
origin hash keeps servers separate. The conversation segment is always a
canonical UUIDv7 and is validated again at the filesystem boundary. A new chat
allocates its final UUIDv7 before its composer, folder state, or local files
exist, so the first prompt already names the durable path and no draft path is
ever renamed.

The workspace is not a grant: the user did not pick it, it does not live in
`folders.json`, the picker reserves the name `workspace`, and the strip shows
only user-selected folders. Its directory is created lazily and nothing syncs
between machines. It is always the first root in the desktop file-tool address
space and the working directory for `run_command`, so a Work chat without a
user folder can still read and write local files.

Composer files do not enter that root when added. Each mounted Work composer
owns a submission UUID and stages its files under
`.staging/<conversation-id>/<submission-id>/`. The chip appears only after the
copy lands there. Removing a chip removes its staged file, while abandoning a
submission removes the staging directory. Staging directories are never tool
roots, command allowances, branch inputs, or prompt paths. A send stores only
the final basenames in the attempt generation config; the transcript renders
them as local chips and resolves their metadata through a conversation-scoped
React Query cache. Browser and foreign-machine chips remain inert.

A pasted or synthetic file has no host path, so the renderer sends bounded
base64 and the decoded limit is 50 MB. A real dropped `File` takes a separate
preload channel: preload calls `webUtils.getPathForFile`, passes the path only
to the main process, and returns only the staging receipt. The page never sees
or submits that path. Main repeats the window, main-frame, and origin checks,
accepts regular files only, copies rather than moves the source, and applies a
512 MB limit. Both paths use a random same-filesystem temporary file and an
exclusive hard link to choose a collision-free staged name atomically.

A file-bearing send reserves the turn on the server before any staged file
becomes model-visible. The reservation checks ownership, mode, live generation,
and competing mutations without creating transcript rows. Promotion then
hard-links the complete staged batch into the final workspace and records a
local journal before exposing each link. Activation creates the turn and
starts generation exactly once; it is idempotent if the response is lost.
Commit removes the staging directory and journal. A definite rejection rolls
back only final paths whose device and inode still match the staged file, which
leaves the staged submission available for retry without deleting a later
replacement. While a journal exists, neither one staged file nor the complete
submission may be discarded because rollback needs those inodes as ownership
proof.

Promotion journals make ambiguous failures recoverable. Before the desktop
host accepts tool work, it asks the authenticated server about each pending
journal. Activated reservations commit locally. A still-reserved orphan is
rolled back only after its abort response succeeds; an ambiguous abort retains
the journal, final links, and staging until the server state can be observed.
Terminal reservations are rolled back. If the server is unavailable or no
longer authorizes the journal, it is retained rather than guessed away. Stale
unowned staging, temporary journal files, and partial clones are swept at shell
startup and whenever the shell connects or switches origin. Pending promotion
journals are protected from age-based cleanup.

Branching copies only the committed conversation root. The branch flow awaits
copied folder grants and `cloneWorkspace` before navigating; failure still
opens the branch and reports that its local files were omitted. Clone
measurement independently limits total bytes, visited entries, and nesting
depth, does not descend through symlink directories, and fails closed when a
limit truncates the walk. Copying targets a random sibling `.partial-*`
directory and publishes it with one final rename. All app-owned creation,
promotion, deletion, and clone publication for a destination share one local
workspace lock, and cloning refuses even an empty existing destination. A
failed copy therefore leaves no partial destination blocking retry without
silently replacing another app operation. Deleting a conversation still fires a
best-effort `discardWorkspace`; there is deliberately no server-validity sweep
because the shell cannot safely infer which committed workspace ids are dead.

Loader preparation holds a query observer so pending route UI cannot cancel a
read the destination still needs. It respects explicit cancellation and
pending folder mutations. Mutations cancel older reads and update only their
original cache entry. Local queries are neither server-rendered nor persisted
in the web backend.

## Several folders, one absolute address space

Every file tool the model sees takes and returns real absolute paths for the desktop's operating system, the
way Cursor and Claude Code work. The system hint names each root with its
path — the workspace first, then the attached folders — and
`list_folder "."` lists the roots by those paths. Find and search return
absolute paths, so a result can be fed straight back into any other tool,
and `cp` between an attached folder and the workspace needs no second
mechanism. Names survive for display alone: the strip's chips, the
transcript's short `name/relative` receipts, and the reserved `workspace`
label the picker refuses for a user folder. Duplicate basenames are refused
at choose and at rebind so a receipt's owner is unambiguous; a lost folder
can be replaced by name from Choose it again. `find_files` names a matching
folder and the files inside it, not only files whose own names match.

Answers can link to `/local-file?path=<absolute-path>` to preview a file, including
one created by a command with no server attachment. This is a renderer marker, not
a route or a tool. The per-answer machine stamp must match the current desktop;
browser-only clients and unknown or foreign machines cannot open it. The preview
reads current bytes only when clicked, through the ordinary root and symlink checks.
It never uploads the file, grants access or navigates to a local URL. HTML stays text;
SVG uses the existing script-free image preview.

A branch retains exact workspace ancestor conversation IDs separately from
`branchedFrom`, which may disappear when the source is deleted. Workspaces are
siblings keyed by conversation ID. Only a path under one of those exact ancestors
relocates to the current workspace with the same suffix. Attached-folder paths stay
absolute, and unrelated siblings are never rewritten. Until the current workspace is
known, references are unavailable. A missing branch copy fails on the destination,
never retries against the source. Paths from a different profile/base directory are
not guessed; unrelocated paths still require current root grants. The model receives
the current workspace and is told to use it for inherited workspace files.

`run_command` takes no folder: the command starts in the chat's workspace,
and the sandbox's write allowance covers the workspace plus every attached
folder, so `cd` and `cp` across roots work inside one address space. Each
command is one fresh sandboxed process; activation, environment changes and
`cd` do not carry into the next call. The shell keeps the desktop process’s
PATH without loading interactive shell startup files. Runtime names, versions
and packages therefore depend on that desktop, not the server or another chat's
machine. The model hint tells it to discover an interpreter when needed, use
local dependencies, honor authenticated proxies and save headless output to files.
It distinguishes the file tools' root containment from the command sandbox's
permitted toolchain reads.

A file a custom tool returned stays a server attachment of the answer in a
Work chat too, never pushed to the machine on its own: the shell may be
closed when the result lands, a resumed or retried generation has no page
listening, and a second machine opening the chat would find a path that means
nothing there. The attachment is the one home that survives all of those, the
same trade a drop makes in the other direction. When the model needs the
bytes on disk it calls `save_to_workspace` with the attachment id its tool
result carried: the page fetches `/api/files/:id` under its own session, so
the shell holds no credential and the server's access rule decides, and the
shell lands the bytes in the workspace root under a collision-free name
through the same primitive a staged drop uses. No approval is asked: the
workspace is app-owned, a drop lands there unasked, and the copy never
overwrites. Given a `path` instead, the bytes are written exactly there, inside
the chat's roots like any write and replacing a file of that name, so the
approval asks first, as for `write_local_file`; that is how a finished deck or
CSV reaches the place the person wants in one step. The tool is a model
operation on the shell's ledger, retained like a write so a replayed call does
not land the file twice.

## Containment and command isolation

File paths pass through `resolveAmongRoots` and `resolveInFolder`. The
requested string is normalized with `resolve()`, matched against each root
textually, and proven contained with `realpath`; existing ancestors are
inspected with `lstat`, and a dangling symlink is not treated as an absent
ordinary path: its resolution fails closed. A root that the requested string
never textually sat inside answers "not mine" and the next root is tried;
when the string did sit inside a root and resolved outside anyway — a
symlink escape or a `..` walk — that refusal is final, so an escape landing
inside a neighbouring root still fails. Refusals name the path the caller
supplied, never a host absolute the caller did not already know. Only
`ENOENT` allows walking to a parent. Moves check both ends. This does not
claim protection against every concurrent filesystem replacement or
hard-link alias.

Commands run in Microsoft's execution containers (`@microsoft/mxc-sdk`), with no
unsandboxed fallback: Seatbelt on macOS, bubblewrap on Linux, an AppContainer
process container on Windows. Each command is one request carrying its whole
policy, so commands run concurrently and share no sandbox state. Availability is
what MXC reports for the machine; where it has no backend (an Intel Mac, a
Windows build without process containers) commands are unavailable, never run
unconfined. The Linux backend has not been exercised end to end.

Windows also needs two capabilities MXC reports per host, and without either
commands are unavailable with a request to update Windows. Host-loopback ingress
is the only way an unpackaged proxy is reachable; the other, `allowedProxyPeer`,
needs the proxy to run as a package or AppContainer identity. Enumeration lets a
command query and list the folders above what it may use, never read their files:
Node's realpath, npm and git stat every one of them up to the drive root and fail
without it. Both arrived with Process Security Environment 1.1 ingress; 26300.9711
has them and was exercised end to end, 26300.9457 had neither. On a supported
build anything not granted is unreadable, a folder made at a drive root included.

The container keeps Win32k on (`ui.disable: false`). MXC's default turns it off,
and every program linking user32 (PowerShell, `where`, `whoami`) then fails at
load with `0xC0000142` and no output. Clipboard and input injection stay denied;
what is given up is that attack surface and the ability to open windows. A policy
naming a missing path is refused whole on Windows, so missing paths are dropped,
which is safe for denied ones: nothing can create them outside a writable folder.

Reads are allow-listed: the system's own directories and the toolchain folders
under home (version managers, package stores, caches, git's identity, and on
Windows the AppData and scoop folders installers use). The rest
of home is unreadable, except one exact file or folder the person lets commands
read through a path request, for the answer, the chat or every chat. A disk root,
home itself, a folder above it, or anything holding credentials is refused before
anyone is asked, and a stored grant breaking those rules is dropped on load.
Credential files and the profile's permission store are
denied, and in MXC a denied path outranks every other grant, so attaching a
parent folder cannot reopen them. Writes are allowed in the chat's workspace, the
attached folders, `/dev/null`, and on macOS the per-user temp and cache folders
that developer tools find through confstr rather than TMPDIR. Temporary files and
the npm, pip and uv caches point at the workspace, since home is read-only.
A tool installed somewhere unusual fails with a denial naming the path.

The only network destination is the [egress proxy](egress-proxy.md). Each command
gets a token, and its proxy URL goes in MXC's `networkProxy`: MXC replaces the
proxy variables with that URL, so a token placed anywhere else never arrives.
Windows proxy mode needs host loopback opened, yet lets a command reach the proxy
and no other loopback address. A refused tunnel comes back as a violation line
for that command, which the site turns into an offer to request access. Grants are exact
`host:port` pairs kept by `egress-grants.ts`, never by the proxy, for the asking
answer, the chat, or every chat. Chat and always grants live in the profile;
answer grants live in memory and end when the page's work state stops listing
that answer, so a closed page ends them all. A private-network grant is its own
kind and is the only way a name may reach a private address. A chat lists and
removes its own grants from the permissions menu; every-chat grants are removed
in Settings › This computer. Both stores forget a chat when its workspace is
discarded, which happens once the chat is purged and Undo is gone.

Loopback is a grant of its own, local network services, in the same three
scopes. Seatbelt has no private loopback: a command talking to itself, as Gradle
does with its daemon and file-lock socket, needs the host's, and the inbound
half cannot be scoped by address, so a server bound to `0.0.0.0` is reachable
from the network. Without the grant a command can bind nothing. Windows proxy
mode refuses even a command's own listener, so there the grant leaves proxy mode:
loopback opens to the host, direct egress stays denied, and the proxy variables
the command already carries reach the proxy as an ordinary local service, the
token keeping one command's grants from another's.

Java ignores the proxy variables. Gradle gets the proxy in `GRADLE_OPTS`, which
reaches its daemon without being printed, and its user home in the workspace
cache. Maven gets a settings file per command, written to a private temporary
folder and removed with it, naming the proxy and a workspace repository, and one
download thread: its client answers a proxy challenge only on its first
connection. `JAVA_TOOL_OPTIONS` carries only `-Djava.net.preferIPv4Stack=true`,
because every JVM prints it on start and IPv6-mapped sockets miss Seatbelt's
loopback rules.

ssh, and with it git, scp and rsync, finds a wrapper first on `PATH` with its
own config: a `ProxyCommand` bridge that opens an authenticated CONNECT, run by
the app's own executable in Node mode so nothing is installed, no connection
sharing (a master would outlive the command's token), known hosts from a copy of
the user's, and no key files, since `~/.ssh` stays denied. Signing in with the
user's SSH agent is a switch granted per chat only, never for every chat, since
the agent signs as the person: granted, the command may connect to the agent's
socket and ssh is pointed at it. A destination such as
`github.com:22` is an ordinary network grant. On macOS the sandbox may look up
directory services, without which ssh cannot name the current user and stops.

The environment starts from identity, locale and terminal variables only. MXC
kills the command's process tree when it exits, and Stop or the deadline kills
it; a detached server a command starts dies with it.

## Policy is server-held; consent is local

The permission level belongs to the conversation; the host refreshes it from
the server. The folder strip is where it is changed: “Approve each action”,
“Auto-approve reads”, or “Auto-approve reads and changes”, with descriptions
in the picker. The stored values remain `manual`, `auto`, and `skip`.

Manual asks for reads too; automatic asks before changes and commands; skip
allows those without another question. None of them grants network access:
that requires a separate model call and explicit consent in its inline approval card.
The dedicated delete tool always asks,
once per call, and a call may name several paths so a cleanup is one
confirmation rather than one per file. An allowed command can also delete
files; this is not a deletion safeguard. Conversation-scoped
blanket edit grants never cover commands or deletes, and manual reads have no
blanket grant. Opening a site in the embedded browser is its own "site" kind,
decided per registrable domain and never covered by a blanket grant; acting on a
page is the "browser-action" kind, with change semantics. See
[the embedded browser](browser.md). These decisions outlive route changes but not
the authenticated execution host. Approval cards remain actionable while generation is streaming,
because the handler is waiting rather than finished.

## Results, search and exact edits

Full local file bytes are transient. Text reads and JS search pull a bounded
prefix from disk rather than buffering the whole file; edits refuse a file
larger than a write. Images and PDFs become model file parts where supported,
with server extraction fallback; persisted tool rows and chunks retain only
bounded summaries. Every returned file also becomes a `local` working file of the
attempt that tools can take and `publish_file` can deliver ([files](files.md#files-into-tools)).
`import_local_file` is the same read under the same consent,
but its bytes are for server tools rather than the model. `readBinary` names its purpose,
`view` or `import`, on every call, and only an import admits Office files: a PNG, JPEG,
PowerPoint or Excel workbook becomes a `local` working file of the attempt, and the model
gets only its `working:` reference, so presentation or spreadsheet tools can place or open it. It is never stored and dies with
the attempt; the way back to disk is publishing and `save_to_workspace`. The result
handler rewrites the very part the continuation replays, dropping the bytes and adding the
reference, before anything can show the file to the model. The page's result is untrusted: summary, detail and file
bytes are capped at one attachment's size and classified once, like any stored file, in the
server function that accepts them,
before they reach the model or process memory; the generation loop only checks
the shape. Native and Hermes loops share this handling.
Research keeps its existing server-side investigation and synthesis paths; this
change does not add local tools to research workers or move their lifetimes into
the desktop host.

Search uses installed ripgrep when available and the JavaScript walker
otherwise; no additional native binary is bundled, and the handler picks the
backend once per call. The fallback tests lines in a dedicated worker with a
parent-owned 30-second deadline. Cancellation, failure and completion await
that exact worker’s termination, so the content-search regexp’s backtracking
cannot block Electron’s main thread. Its worker source is embedded in the main
bundle and needs no packaged worker entry point. Both skip symlink traversal,
include hidden files other than `.git`, and honour `.gitignore` even outside a checkout. They are not
identical: rg also reads `.ignore`, `.rgignore` and repository excludes, gives
a deeper `.gitignore` precedence where the walker ORs them, and has its own
glob and regex dialects. rg runs with `--no-config` so a user's
`RIPGREP_CONFIG_PATH` cannot add `--follow` or `--no-ignore`. Its exit code 2
covers any error, including one unreadable file, so a run that produced a
summary is a partial answer and only a run with none is a failure, with a bad
pattern or glob told apart by rg's message.

Edits require an exact, unique match unless `all` is set. Replacement text is
literal, including dollar-substitution tokens. Before constructing output,
the handler counts nonoverlapping replacements and measures their projected
UTF-8 bytes, including surrogate pairs at edit boundaries. Both original and
resulting files must fit the same decimal 2,000,000-byte write limit. Refusal
leaves the source unchanged and performs no replacement construction, write or
diff. `diff` supplies a bounded unified
preview; expensive or oversized previews are marked truncated rather than
blocking indefinitely. A preview limit does not change the applied replacement.
