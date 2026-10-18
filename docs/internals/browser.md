# The embedded browser

The desktop app shows web pages as panel tabs. Phase one is a browser the person drives;
the model's browser tools build on it later and stay Work-only.

## Guests are the page's, the gate is the shell's

Pages are Electron `<webview>` guests created by the site, not `WebContentsView`s owned
by main. A guest is part of the DOM, so menus, dialogs and the command palette draw over
it with ordinary z-order; a native view would sit on top of everything. The price is that
a renderer reload ends every page.

The site is still remote code, so main decides every attach (`browser/guest-policy.ts`,
wired by `browser/guests.ts`):

- the window must be showing the configured origin
- the guest must use one of that origin's partitions
- it must start at an `http(s)` address or `about:blank`

An admitted guest loses any preload and is forced into `sandbox`, `contextIsolation`, no
Node and `webSecurity`, whatever the markup asked for. Guests may only navigate to
`http(s)`.

- **Permissions:** every guest permission is refused except clipboard writes.
- **User agent:** the app-wide default, which main keeps to Electron's own string minus the
  app's name; guests are never given an agent of their own. The token the server keys
  desktop sessions on is set on the app's own session only. Measured with a throwaway
  Electron probe hosting a `<webview>` on real Cloudflare Turnstile sitekeys: only what
  Electron generates passes, and only while the app-wide default is left that way. A
  Chrome-looking string without `Electron/`, a token Electron did not write, or the server
  token in the app-wide default all failed. The last one failed even with the guest's
  profile set back to the exact native string. Some sign-ins refuse embedded browsers
  regardless.
- **Mouse buttons:** Electron's input events know only left, middle and right, so a
  listener in an isolated world, injected at each `dom-ready`, maps buttons 4 and 5 to back
  and forward. It shares the page's DOM but none of its scripts.
- **Popups:** native windows are refused. While a model call drives the source, main checks
  its site gate before forwarding the address, so a refused popup reaches neither a replacement
  guest nor the system browser. Approved popups and ordinary human browsing still open a tab
  beside their source when that chat is on screen and the system browser otherwise.

## One profile per server

Logins live in the partition. Each connected server gets `persist:browser-<hash of
origin>`, shared by its chats, so a site is logged in once. A page from one server never
browses with cookies another server's chats collected. Temporary chats get
`browser-temp-<hash>-<conversation>`, which Chromium keeps in memory only.

Main names the profile in a preload argument, as it does the pinned server. The sandboxed
preload cannot load Node, so the hash is computed in main (`browser/profile.ts`) and the
preload only builds names from it.

The `browser` bridge is optional and independent of `PROTOCOL_VERSION`, like `network`.
An older shell has none, and the site then offers no browser. A shell whose model bridge lacks
call admission, cancellation or main-owned navigation keeps human browsing but offers no
model browser tools.

## Pages live outside the routes

`browserTabs` (`modules/browser/client/browser-store.ts`) holds every page outside React.
Each belongs to the chat on screen, or to the page itself when that is not a chat (a
project, say). The new-chat page has no panel at all, since sending leaves it. `BrowserHost` renders one `<webview>` per live page into `document.body`,
so switching chats or panel tabs never unmounts one.

A panel tab's body is only a slot. It reports its rectangle, and the store writes the
geometry straight onto the element: on resize, and every frame until the rectangle has
held still, which covers the panel opening, the phone overlay sliding in and the rail
being dragged. A hidden page keeps its size so it does not relayout. Its `src` is set
once, because changing it later would reload the page, so navigation goes through the
element.

Because a page is drawn above the panel, it would cover the panel's resize handle, and a
drag crossing it would lose the pointer to the page's process, which pointer capture
cannot reach. A filling body therefore leaves the handle's strip uncovered, and while the
panel is resized every `webview` ignores the pointer.

A browser tab is restorable with its address as stored data. `BrowserPanelOwner` in the
chat view brings a tab back as a discarded page, and the page loads when shown. Closing
the tab in the panel ends its page. A tab in an in-memory profile (a temporary chat's) is
not restorable, read off its partition, since nothing of it survives. Which chats are
temporary is recorded in the store, by the chat view and by each browser call's `meta`,
so every new tab of a chat picks the same profile. Outside the desktop app, restored
browser tabs are closed, since nothing can show them.

In the desktop app, a web link clicked in the conversation or the panel opens as a tab of the
chat on screen rather than in the computer's browser: the panel keeps the person in the app and
shows the real address, so rendered markdown skips its leave-the-app question there. A setting
under This computer makes the computer's browser the default instead; ⌘ or Ctrl asks for the
other. Plain links are caught where they are clicked, limited to `data-web-links="panel"`
containers so links on other pages (an integration's sign-in) keep opening outside. Markdown
links are buttons that open through Streamdown's link check, so its dialog
(`~/ui/link-safety.tsx`) is where the browser layer's opener takes over.

The app menu's View items (reload, developer tools, zoom) are written out in `main.ts` rather
than Electron's `viewMenu` role: a role acts on whatever has focus, which after a click into a
page is that page, so reloading the app would reload the page instead.

Hovering a link shows its address at the page's bottom corner, as a browser does. The
webview reports it (`update-target-url`), and the store places that line over the page with
the page's own geometry, since the page is drawn above everything in the panel.

A tab shows the page's favicon. Main sees each guest's favicon URL, fetches it in the
page's own session (so logged-in and intranet sites work) and hands the page a small
`data:` image. Receiving stops at 64 KiB or five seconds, and a newer icon, guest destruction
or host navigation cancels the old receive. Each request keeps the authority it started with.
A model-origin receive ends with its drive or call, including cancellation and expiry. Its
manual redirects check that original authority before contact, never treating a released drive
as human authority. A genuinely human-origin request stays human if a model drive starts later.
The site's CSP admits no other image origin,
and the server's `/api/favicon` proxy would neither reach those sites nor stay private. A tab's spinner
and the stop/reload button follow loading only once it has stayed off a moment, because
pages like Google stop and start several times as they finish.

## Lifecycle

`planLifecycle` decides how each page runs, and the host applies the plan through the
bridge:

- a shown page is active
- a hidden page is throttled
- a page unseen for five minutes is frozen with the DevTools protocol's
  `Page.setWebLifecycleState`, keeping its state but running nothing
- past eight live pages, the least recently shown are discarded: the element goes, the
  address stays

The chat on screen and a page playing sound are never frozen or discarded. A chat with
an answer running on this desktop is held (`browserTabs.setHeld`, from the Work
snapshot): its live pages run fully. Holds outrank the cap, but a hold alone never
reloads a discarded page; the call that needs the page does.

A renderer reload is one big discard: tabs come back from their addresses, and logins
survive in the partition.

## The model's browser tools

In Work chats, the model gets `browser_tabs`, `browser_open`, `browser_navigate`,
`browser_snapshot` and `browser_wait_for` to read and move, and `browser_click`, `browser_type`,
`browser_press`, `browser_scroll`, `browser_select` and `browser_evaluate` to act. They are desktop tools: the same family, envelope,
`ExternalCompletion` wait and result shape as the file tools. Only two things differ: they are
offered when the sending app reports `desktopBrowser`, meaning its shell has the bridge's
`agent` surface, whatever folders the chat has, and the page runs them itself (`browser/client/execute-browser.ts`) rather than
through the Work RPC. A screenshot travels as `result.file`. It becomes a `local` working file of the attempt
([files](files.md#files-into-tools)), shown to a vision model and offered by reference. The
user sees one only when the snapshot is taken with `share`, which attaches it to the answer
and stores it with the chat; the result's first line tells the model which happened, since a
model that sees a picture assumes the reader does too. With `save` the page writes it into the
chat's workspace on the computer instead, through the Work bridge, so it never reaches the
server. Like t3code, the tool set stays small: one snapshot tool with a few flags, no
full-page mode, rather than a tool per way of looking.

The transcript is for people who never see the tools. A run of browser calls is one row, like
the web and knowledge rows (`chat/ui/browser-activity-block.tsx`, sharing their
`useRunDisclosure`): its header names the sites browsed, and it opens onto the steps in plain
words (`browser/wording.ts`), an element named by what the outline said it was, never `t1`
or `e12`, with each page linked where the run reached it. Results carry that page as structured
`page` data for this; their detail is written for the model and never shown. A step waiting on
the user keeps its approval card under the row. The hint tells the model to keep its handles
out of its replies too.

- **Tabs** are named `t1`, `t2`, … per chat, kept with the tab's stored data. A tab opened by a
  call remembers that call, so a replayed call finds it instead of opening another. A tab the
  model opens or moves in the chat on screen is shown and selected. Elsewhere it is added to
  the chat's panel the next time that chat is shown.
- **Waking:** each call wakes its page first. A discarded page loads again and a frozen one is
  thawed by the hold every chat with a live attempt gets.
- **Reading:** `browser_snapshot` is the accessibility tree from the DevTools protocol, outlined
  by `browser/snapshot.ts` with references like `[e12]` for interactive elements. Those
  references are kept per tab for later actions. A page that has not painted can fail a
  capture or never answer one, so each try is bounded and retried, then the protocol renders a
  frame on demand. If none yields a picture, the result says so.
- **Scrolling:** `browser_scroll` moves the page, or a scrollable element by reference, by exact
  pixels with `scrollBy`, and reports how far down it ended up. Never wheel events: those
  scroll whatever is under the pointer. Clicking and typing scroll their element into view.
- **Waiting:** `browser_wait_for` checks fixed code in an isolated world, with the text as a
  JSON literal. Nothing from the page or the model runs. Each awaited probe is bounded by
  the remaining wait and call deadline, not just the interval between probes. An unresolved
  read-only probe releases its wait without terminating or replacing the person's page.

### Sites

Opening an address is the `"site"` approval kind, decided per call and per registrable domain.
A navigation without one (back, forward, reload) stays where the tab is, so it is a read;
`approvalKind` takes the call's arguments for this, on the server and in the page alike.
Domains come from `browser/site-grants.ts` (`tldts` with private suffixes, so
`alice.github.io` is not `bob.github.io`).

- **Pre-approved:** the server pre-approves an address the generation's URL authority holds,
  meaning one from the user's text or earlier sources, never from assistant prose. It says so
  in the call's `meta`, apart from the persisted args.
- **Already allowed:** the page asks the desktop whether the site is allowed in this chat or
  on this desktop. That answer is asynchronous, so a site call shows no card until it arrives.
- **Asking:** otherwise the card offers "Allow once", "Allow in this chat" and "Always allow".
  A remembered site re-checks the chat's other waiting site calls. `allow-rest` never covers a
  site.
- **Storage:** grants live on the machine in `browser-sites.json`, per server origin. Like
  folder and network grants, the server never learns which sites a person trusts. "Always"
  sites are listed and removable in Settings › This computer. A chat's sites go when the chat is
  purged, with its folder, network and path grants. One purged while the app was closed is never
  named to it, so per-chat grants are also kept only for the 500 chats granted to most recently.

While a call drives a tab, main gates its page: a `will-navigate` or main-frame `will-redirect`
to a site neither allowed for the chat nor the one this call was allowed to open is cancelled,
and main hands the call the address it stopped. The call then asks the person itself, with the
same site card on its own row, and the page goes on to that address if they allow it, so a
link the model clicks needs no second call. A refusal is the call's result. Without this, a page could lead an approved
visit anywhere, including to an address carrying what it read. The person's own browsing is
never gated.

### Acting on a page

Actions go to main as one `act` call. Main resolves a reference from the tab's latest outline to
its DOM node, scrolls it into view and clicks its centre with trusted mouse events. The keyboard
never goes through the protocol: in a `<webview>`, `Input.insertText` and key events go to
whatever holds the window's focus, which typed the model's text into the app's own message box
and sent it. Typing runs the page's own editing command on the field, with the text as an
argument, and a key press is dispatched as key events inside the page, doing what the key does
(submitting a form, deleting, moving focus) there too. A click by coordinates is mapped from the last screenshot's pixels through its recorded
scale. References and that scale are dropped on every main-frame navigation, and a stale one
says "take a new snapshot" rather than clicking whatever is there now.

- **Call lifetime:** main admits a fresh execution identity with one chat and a deadline at
  most five minutes away. Every model IPC carries that identity. Main checks it before
  dispatch and after awaited protocol steps, and cancellation or expiry revokes later work.
  Ended identities stay refused for the maximum lifetime of a queued request. The ledger is
  bounded and refuses new starts while a cancellation it could not store might arrive late.
- **Replays:** an action's stable call id is separate from its execution identity. A replay
  gets fresh lifetime authority but returns the first action result instead of acting twice.
  Retired IPC identities cannot start again. An action that failed to reach the page is
  forgotten, so a replay may try again.
- **One at a time:** the renderer serializes calls per tab. It checks cancellation at dequeue,
  before revealing or waking a tab, after drive acquisition and before dispatch. A cancelled
  queued call cannot later act when its predecessor releases the tab. Awaited IPC is bounded
  too, so an unresponsive wait cannot retain the queue.
- **Driving:** every action runs driven, through the same navigation gate as a page load, with
  the site the page is already on allowed too: being there was allowed one way or another
  (once, from the user's text, or by the person). A click that leads somewhere unapproved is
  stopped and reported, so the model has to ask. Release is scoped to the owning call, so an
  old cleanup cannot release a newer drive. Stop revokes new dispatch immediately. The
  renderer waits briefly for already-submitted work before releasing the gate, not forever
  at the expense of human browsing. An action's result is kept as soon as main returns it,
  so a slow load afterwards never makes a click that happened look like one that did not.
- **Code:** `browser_evaluate` runs the model's expression in an isolated world, with a
  10-second limit and a capped JSON result labelled as data. It sees the DOM but none of the
  page's scripts. At the limit, if the page cannot answer a trivial expression, its thread is
  busy and the script is terminated through the DevTools protocol, since a loop would keep the
  tab from every later call. Otherwise the code is only waiting and is left alone: terminating
  then would end the page's own next script instead. Call cancellation does not undo submitted
  JavaScript or prevent all of its later effects. Retiring arbitrary evaluation while
  preserving the person's page state remains unresolved, not an enforcement guarantee.
- **Approvals:** click, type, press, select and evaluate are the `"browser-action"` kind with
  change semantics. They ask under manual and automatic approval, and run under "reads and
  changes" or after "Let it use the browser for this chat". Scrolling is a read. The card shows
  the code it is asked to run, and names an element by what the tab's last outline said it was
  (`link "Learn more"`), which the page remembers per tab and address, not by its reference.
- **Secrets:** what `browser_type` types reaches only the call the page runs; the tool row and
  the live chunks never hold it, flagged or not, because a model that forgets `sensitive`
  would otherwise store a password before the page could refuse it. An approval card reads
  the text from the waiting call in memory, masked when `sensitive`. A password field refuses
  text not marked `sensitive`, and a field a secret went into reads as masked in every later
  snapshot of that page. The prompt tells the model to type a secret only when the user gave
  it for that site, and to ask with `ask_user` for logins and captchas.
- **Indicator:** from an answer's first call in a tab until the answer stops running, a frame is
  laid over the page (an element of its own: the page paints over its element's edges, and its
  box runs to the window's) and a "Working on …" note with the composer's Stop takes the address row's place
  at its height, so it neither flickers between calls nor moves the page. The chat's sidebar row shows a globe in
  place of its spinner.

`browser_save` is how the model saves files it finds: given their addresses, main fetches them
with the tab's own session and lands them in the chat's workspace. From main no page's
cross-origin rules apply, and files behind the user's logins come too. It runs driven, through
the same gate as navigation. Native `net.request` uses the guest's session with credentials
included. Electron's `session.fetch` rejects manual redirects, so the request's redirect event
returns headers without calling `followRedirect`. The caller authorizes and issues each next
request itself, at most eight redirects. A blocked destination is reported separately from
the original file address, so approval grants the destination and retries the original.
Receiving enforces the byte cap against actual streamed chunks, even without a truthful
Content-Length. The native producer also checks bytes before queuing them, since its response
emitter has no backpressure API. Aborting cancels both the native request and its body.
Drive release, cancellation, expiry and guest or host teardown abort the save.
The signal reaches workspace writing and the check immediately before publishing each final
name, including collision retries. A link already submitted may commit. This is prevention
of not-yet-submitted publication, never rollback of a file already saved.

A file a driven page downloads (a link the model clicks, or one `browser_evaluate` starts) lands
in the chat's Work workspace, never in a dialog over the app, and the call reports where. Main
claims a download for the chat while its call drives the tab and afterwards until the person
next clicks or types in that tab (ten minutes at most), since a click starts one a moment later
and a script may after it returned. Normal release waits at most thirty seconds for downloads
under way. Explicit cancellation and expiry cancel owned items and revoke that lingering
ownership. A revoked drive may remain until cleanup to gate navigation, but a download arriving
then is cancelled before receiving or landing. Admission checks its call deadline even before
the expiry timer runs. Normal successful release and end keep the bounded linger, which is
separate from active call authority. At most four model downloads run at once, each for at most a minute, with declared
and received-byte progress checks. A download waits in a folder in the app's own data, never
the system temp folder, which on macOS every command can write; the folder is emptied
once per run, so a crash mid-download leaves nothing for long. Completion reads the exact
owned temp file through a bounded file handle before landing, then removes only that file. Cancelled items also clean up a late
terminal report. Downloads the person starts keep the Save dialog.
