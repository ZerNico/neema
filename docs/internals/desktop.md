# Chats' computers and the desktop shell

The Electron shell loads the deployed site and exposes an origin-checked,
schema-derived bridge. The web application owns authentication. Electron owns native window
controls, folder grants and the computers of chats: a Linux microVM per chat, which runs that
chat's local tools. Host paths stay on the machine. The server and the model only ever see
folder names and the VM's own paths.

The model in five rules:

1. A chat may have a computer. It binds to one of the person's machines the first time it
   needs one. There is no chat mode.
2. Everything local runs in the chat's VM: commands and file tools alike. The VM sees only
   `/workspace` and the attached folders, and its only way out is the
   [egress proxy](egress-proxy.md).
3. The machine is the executor, not a page. The desktop's main process holds one connection
   to the server as that machine, and calls are routed to the chat's machine from any device.
4. Decisions live on the server: the permission level, network grants and approvals. The
   machine keeps what is its own: folders, the SSH agent allowance, its VMs.
5. Offline is a state. A chat whose machine is offline still works from its context, and a
   local call is answered at once with that reason.

The window uses `hiddenInset` on macOS and `hidden` with Window Controls Overlay
on Windows/Linux, retaining standard controls rather than web replacements.
An optional presentation capability, independent of the protocol version,
provides platform, fullscreen state and a validated theme preference. An optional
`browser` capability, also outside the protocol version, names the server's browser
profile and paces embedded pages; see [the embedded browser](browser.md). Theme writes
require the same configured origin, main window and main frame as bridge calls.
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
strips. Their preloads expose no bridge surface, and local actions require the exact
bundled document, window and main frame. Recovery can retry only the configured
server. Aborted/subframe failures are ignored, and an established renderer
is not replaced merely because later network activity fails.

The server chooser is not only a first-run screen. The app, dock and tray menus,
the recovery page and the site (sign-in screen, account menu, through the `auth`
capability) can all reopen it, and each of them can only ask: the address is
typed in the chooser, never sent by a page, so a compromised site cannot point the
bridge at another origin. Connecting writes the config, replaces the main window
with one for the new origin and destroys the chooser; cancelling the chooser
while a main window exists just closes it. Local work belongs to the server that
started it, so opening the chooser or confirming a new address while work is
active asks first, with the same wording family as Quit, and disposes
the server's computer and its running calls only after a yes. A chooser opened while idle
does not skip that question if work starts before connect. Folder and other grants
are keyed by server origin, so the next server inherits none of them.
`CHAT_DESKTOP_SERVER` pins the server for development: main tells every
preload through a process argument, the site and recovery page then show no
switch at all, the menu item is absent, and the IPC still refuses as a backstop.
`connect-flow.ts` holds this logic electron-free. During dev reload,
`CHAT_DESKTOP_PROFILE` selects userData before services or sessions open; the root
dev runner supplies a checkout-local directory. The installed profile is unchanged.
See [development isolation](development.md). An address must be https, or plain http
on this machine, whether typed or saved: whoever sits on the network path of a plain-http
server could inject the script that drives the browser tools and the bridge. A saved one that is not
opens the chooser.

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
keys on the session's `desktop` field, which the desktop-sessions plugin
declares and sets only on redemption. A user agent is never consulted: any
browser can send the shell's `ChatDesktop/` token, and a session signed in
with it is still a seven-day browser session. The gate is a convenience, not
a boundary: any authenticated browser can mint and redeem a ticket and hold a
90-day session that way. The Devices label "neema Desktop on …" reads the
same mark. Revoking
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

## A chat may have a computer

- **A machine** is one desktop install a person signed in on, keyed by its own id
  (`machine.json`) together with the person, in `machines`. A reinstall is a new machine.
- **A chat binds to a machine** (`conversations.machine_id`) the first time it needs one. The
  first local call of an unbound chat asks which machine to use: the one the message was sent
  from when it is online and ready, else the person's first ready one. The question is an
  ordinary approval card. A newly bound chat holds only an empty workspace, so binding opens
  nothing of the person's.
- **Folder names** are reported by the machine (`computer_folders`): names and read-only only,
  never paths. They feed the model's hint and the computer tag in the header.
- **Switching computers** (`switchChatComputer`) points the chat at another machine and clears
  its folder names, which belonged to the old one. Nothing is copied between machines.
- **A branch keeps the source's computer.** The server sends that machine a `clone` event and
  it copies the workspace's files into the branch's, within the copy limits, and gives the branch
  the source's folders. Installs stay on the source's disk. The branch starts with no folder
  names on the server and hears them from the machine once copied, so a machine offline at that
  moment leaves it with an empty workspace and no folders, never folders it cannot mount.
- **Purging a chat** sends its machine a `discard` event: the VM, its disk, its workspace, its
  folder grants, its SSH agent allowance and its browser sites go. A machine offline then
  misses it, so on start it asks `/api/machine/gone` which of the chats it holds anything for
  no longer exist, and discards those. Only a chat whose row is gone for everyone counts: a
  machine may hold another account's chats, and a chat without a computer may still have
  browser downloads in its workspace.
- **The tools are offered** to people who may use a computer (the `work` feature) and have
  connected a desktop app at least once, from any device and whether the machine is online or
  not. The offer is stable per person, so the cached prompt prefix is too, and nobody without
  the app pays for the schemas. Chats with a computer show a file icon in the sidebar.

## The machine connection

The desktop's main process runs one `ComputerHost` per connected server. Its `MachineClient`
holds `GET /api/machine/events` open for as long as the app runs, reconnecting with backoff.

- **Only a desktop session may act as a machine.** `/api/machine/*` requires the session's
  `desktop` mark, which only the desktop sign-in sets. The machine's hello travels in the
  `x-neema-machine` header on every request: its id, name, platform, computer status and
  whether it allows remote use. The id is scoped to the person, so it can only name one of
  their own machines.
- **Presence is in memory** (`MachineHub`): there is one server process, and a machine whose
  stream drops is offline until it reconnects. A second stream from the same machine replaces
  the first.
- **On connect** the server sends the person's network grants, then resumes calls held for the
  machine. A new status arrives as `POST /api/machine/status`.
- **A call** (`call` event) carries the tool, its arguments, the server's deadline and the
  time it was sent, so the machine measures the deadline on its own clock. It also carries the
  chat's sent files and the guest path the server named for each.
- **A result** is posted to `/api/machine/calls/:id/result`, retried until the server answers
  or the deadline passes. The server accepts it only from the machine it sent the call to, and
  caps and classifies it like any untrusted result (`acceptDesktopToolResult`). A finished
  call's result is kept on the machine for ten minutes, so a call sent again after a reconnect
  gets the same answer, not a second run.
- **Stop, a lost lease and the deadline** end the call's scope on the server, which sends the
  machine a `cancel` for a call still running there.
- **A reconnect loses what the old stream had not delivered,** calls and cancels alike. So each
  new stream starts with `running`, the calls the server still waits on from this machine, and
  each of them again. The machine stops any other call it is running and answers a repeated one
  from what it has.
- **The page is not in the execution path.** Closing, reloading or never opening the window
  changes nothing for computer calls.

### Offline, preparing, unavailable

- **Offline:** a call to a chat whose machine is not connected is answered at once, naming the
  machine and when it was last seen. The attempt's hint says the same before any call, so the
  model works from what the chat holds instead of trying.
- **Preparing:** a machine still downloading its image reports its progress. A call to it is
  held, not answered, and runs once the machine reports ready. Only if the download outlasts
  the call's own deadline is it answered, five seconds before, with how far the download got.
  An instant failure invited the model to work around a half-ready computer.
- **Unavailable:** a machine that cannot run VMs says why, and calls are answered with that.

## Approvals and permissions

- **Decisions live on the server,** in `ComputerCalls`. An approval is a state of the call,
  held while its generation lives, shown to every client of the person through
  `computerSnapshot` and answerable from any of them with `decideComputerCall`.
- **The permission level** is the chat's (`permission_level`): `ask` asks before changes and
  commands, `allow` does not. Reads never ask: the VM bounds what they reach. A delete and a
  new network destination always ask. "Allow for the rest of this chat" is kept in memory per
  chat and kind, until the server restarts.
- **Network grants** are `network_grants` rows: a `host:port`, for one chat or every chat of
  the person, with a flag when the approval card showed a private address. Approving
  `request_network_access` writes one and pushes the whole list to the person's machines,
  whose proxies decide by it. Removing one closes the tunnels it allowed.
- **The machine's own resources are asked for at the machine, in native dialogs** that a page
  cannot draw, fake or answer:
  - `request_folder` with a path the person named shows a confirm, with "Don't ask again for
    this folder on this device" kept on the machine. Without a path, the folder picker opens.
  - `request_ssh_agent` shows a confirm, and a yes is kept on the machine, per server and chat.
  - Both run only for a message sent from the chat's own machine. From another device they
    are answered at once, so another device holding the person's session can never open them.
  - The dialogs' words are the web app's messages, compiled into the desktop's own
    `src/paraglide`, in the person's language from the page's `language` cookie, else the
    system's ([languages](i18n.md)).
- **Remote control** is the machine's switch (on by default): with it off, calls run only for
  messages sent from that machine.
- **Which machine a message came from is the session's, never the request's.** A machine's
  event stream and its own page share one desktop session, so a call counts as sent from the
  machine whose stream holds the sending session. A request naming a machine would prove
  nothing: any session of the person could make it. It is asked when the call is decided, so
  a reconnect in between changes nothing. A queued message the server starts has no request,
  so it counts as sent from the session that queued it, kept on the entry.
- **Attaching a folder yourself** happens in the desktop app on that machine, through the
  native picker, and refuses a folder that is a disk root, the home folder itself, the app's
  own data, or holds or lies inside credentials (`folder-access.ts`), judged by where links
  lead. A folder may be attached read-only.

## A VM per chat

`ChatVms` runs one microsandbox VM per chat (`computer/vms.ts`).

- **The VM is disposable, its disk is not.** Each chat has a root disk on the host
  (`<userData>/computer/disks/`), a sparse ext4 image holding the VM's writable layer: what
  the chat installed. The VM itself is recreated whenever its mounts change, in about 200 ms,
  and the installs stay. A disk made from another image starts over, since installs made on
  one image's files do not belong on another's.
- **One operation at a time per chat,** which is also what lets a mount change recreate the VM
  safely between calls.
- **A running VM stops after five idle minutes** and on quit. The next call restarts it.
- **Mounts:** the workspace at `/workspace`, each attached folder at `/folders/<name>`,
  read-only where chosen, with host permissions mirrored. microsandbox refuses a mount path
  that goes through a symlink. A link inside a folder that points outside it does not resolve
  in the guest. A link the guest plants is followed by host programs that open it: attaching a
  folder trusts what runs from it, as with its scripts.
- **Commands run as root.** The VM is the boundary, not users inside it. `apt`, `pip` and
  `npm` work through the proxy.
- **Each command runs in its own cgroup.** Stop and the deadline write `cgroup.kill`, which
  takes every process it started, `setsid` and `nohup` ones included. When the shell exits on
  its own, the wrapper steps back out of the group and kills it too, so a server left running
  in the background ends with its command instead of holding the output open (measured both).
- **Resources:** 2 vCPUs and 2 GB of memory per VM. Freed guest memory goes back to the host.
- **microsandbox keeps its data** under `<userData>/computer/runtime` (`MSB_HOME`), so a dev
  profile and an installed app never share VMs.

## Addresses

- **The model's paths are the guest's:** `/workspace/...` and `/folders/<name>/...`, the same
  on every operating system and in every branch. Host paths never reach the server or the
  model. The hint names the roots, and `list_folder "."` lists them.
- **`/local-file?path=/workspace/plot.png` links** open only on the chat's own machine. The
  desktop maps the guest path to the host (the workspace folder, or the attached folder of
  that name) and reads it there. A guest can swap links while the host reads, so after the
  realpath check the file is opened, the path resolved again, and the read refused unless the
  open file is the same device and inode.

## Files into and out of the chat

- **A file sent in a chat is an attachment,** whatever the device. Its path on the computer
  is decided by the server from the chat's files in order: `/workspace/<name>`, numbered when
  an earlier file took the name. Every call carries the list, and the machine copies a file
  once, and never over a file already at its path: an edit the model made is never put back, and
  a file it deleted or moved stays gone. The machine remembers what it placed, per chat. The hint
  names the paths.
- **`save_to_workspace`** downloads a file the chat holds with the machine's own session and
  lands it in the workspace, or exactly at a path the person approves.
- **`import_local_file`** reads a picture or an Office file from the computer into the answer
  as a working file for the server's tools. Its bytes are never stored.
- **A browser download** lands in the workspace under a fresh name.

## Network

The VM's only way out is the egress proxy, which decides by name. See [egress proxy](egress-proxy.md).

- **Every TCP connection** goes through microsandbox's outbound CONNECT proxy to ours, with a
  credential per VM held on the host and read from the environment only while the VM starts.
  The guest has no proxy settings, so Java, ssh and git need none.
- **The guest's DNS** goes to the proxy's name listener for that VM, which answers with
  placeholders and resolves nothing until a grant allows a connection.
- **UDP** goes only to the gateway's DNS. There is no QUIC and no direct DNS.
- **Built-in grants** cover the package registries and the image's Ubuntu archives on 443.
  Everything else needs a grant. A service on the person's own machine is `host.internal`
  with its port, served by the proxy's local connector once granted.
- **A refused connection** fails in the guest as a refused connection, and the command's result
  names each destination with what would open it.

## SSH

- **ssh, git and rsync connect normally** through the proxy. `github.com:22` is a grant like
  any other.
- **The agent** is relayed, never mounted. Each chat gets a host socket (a named pipe on
  Windows) that microsandbox exposes over vsock, and the image's `ssh-agent-bridge` presents it
  as `/run/ssh-agent.sock`, set as `SSH_AUTH_SOCK` for commands of a chat allowed the agent.
  The relay passes a connection only while the chat is allowed, and revoking cuts the open
  ones. Commands can ask the agent to sign but never read a key.
- **Which agent:** the socket chosen in Settings › This computer, else `SSH_AUTH_SOCK`, else
  Windows' OpenSSH agent pipe. Windows' agent service is disabled by default, and Pageant and
  Git for Windows' own agent are not supported. An empty agent needs the person's `ssh-add`.

## Browser calls stay with the page

The embedded browser's tools run in the page's webviews, so they keep the page executor
(`DesktopWorkProvider`, `work-host.tsx`). A submission from the desktop app carries the app's
execution session (`executorId`), its machine and whether it can drive pages. Only browser calls
are registered under that executor and claimed by the page. Computer calls are registered under
`COMPUTER_EXECUTOR`, which no page claims. A page that reloads joins a browser call already in
flight by its call id. Closing the window hides it, keeping the renderer and its browser calls,
and an explicit Quit asks while work is active. See [the embedded browser](browser.md).

## The image

- **One image for every chat's computer** (`infra/sandbox-image`): Ubuntu 26.04 LTS with
  Python 3.14 and the document packages, Node, uv, LibreOffice, pandoc, tesseract, ffmpeg,
  ImageMagick, poppler, git and build tools.
- **An image is named by its sources.** CI tags it `tree-<hash>` of `infra/sandbox-image` and
  its workflow, and reuses an existing tag instead of rebuilding. Rebuilding the same sources
  would still give a new image, since apt is not pinned, and every new image resets each chat's
  installs. So the image changes only when its sources do.
- **A release boots the image of its own commit.** Its sandbox job resolves or builds that tag
  and hands `name:tag@digest` to the desktop build, which bakes it in (`__SANDBOX_IMAGE__`).
  The digest is what is pulled, so a published release cannot be moved to other bytes. Other
  builds follow `edge`, which main moves.
- **Updates come once a month, together.** Renovate groups the base image digests and the
  Python lock refresh on the first of the month, which is when chats lose their installs. The
  guest kernel is not in the image: it ships with microsandbox's `libkrunfw`, updated with the
  app. A guest flaw reaches no more than the model already can, so monthly is enough.
- **The model hears of a reset once.** The first call after a chat's disk was made over for a
  new image starts with a note that earlier installs are gone and files are kept, so the model
  reinstalls instead of puzzling over a missing package.
- **Layers are ordered by how often they change:** system packages first, Python last, so a
  refresh that leaves the base alone downloads only the top layers.
- **Our own image** because the hint promises what is installed, and because the image carries
  what the computer relies on: the agent bridge, apt over HTTPS and git trusting mounted
  folders owned by the host account.
- **Python lives in `/opt/venv`,** first on `PATH` for login shells too. pip cannot replace the
  modules Debian installs, so neither our packages nor the model's could go into the system
  Python.
- **The machine pulls the image when it connects,** reporting the share of bytes done, and
  booting a throwaway VM of it proves the machine can run one.

## Packaging

- **Platforms:** macOS on Apple Silicon, Windows 11 with Windows Hypervisor Platform (preview in
  microsandbox), Linux with access to `/dev/kvm`. Elsewhere the machine reports itself
  unavailable.
- **The app stays a plain directory** (`asar: false`): microsandbox loads its native addon, `msb`
  and `libkrunfw` from paths beside its own modules. After packing, only the target's platform
  package is kept.
- **macOS:** signing the app signs nested binaries with the app's entitlements, which have no
  hypervisor access, so `after-sign.mjs` signs `msb` again with `build-resources/msb.entitlements`
  and reseals the app. A root disk on Windows is marked sparse before it is extended.

## Results and exact edits

- **One result shape** for every tool (`ToolResult`): a summary for the transcript row, a
  detail for the model, a truncation mark, refused destinations, and bytes for an image or PDF
  the model can look at. Full file bytes are never persisted.
- **Edits** require an exact, unique match unless `all` is set. Replacement text is literal. The
  projected size is measured before anything is built, and a file written back whole must be
  strict UTF-8, so a file that is not cannot be damaged. A file with Windows line endings keeps
  them. `diff` gives a bounded preview.
- **Find and search** run `rg` in the guest with `--no-config`, hidden files included, `.git`
  skipped and `.gitignore` honoured outside a checkout. A folder whose name matches a glob is
  listed with the files inside it. rg's exit code 2 covers any error, so a run with a summary
  is a partial answer and only a run without one is a failure.
