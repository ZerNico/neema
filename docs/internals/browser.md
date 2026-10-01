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
- **Popups:** refused, and sent back to the page, which opens one as a tab beside its source
  when that chat is on screen and in the system browser otherwise.

## One profile per server

Logins live in the partition. Each connected server gets `persist:browser-<hash of
origin>`, shared by its chats, so a site is logged in once. A page from one server never
browses with cookies another server's chats collected. Temporary chats get
`browser-temp-<hash>-<conversation>`, which Chromium keeps in memory only.

Main names the profile in a preload argument, as it does the pinned server. The sandboxed
preload cannot load Node, so the hash is computed in main (`browser/profile.ts`) and the
preload only builds names from it.

The `browser` bridge is optional and independent of `PROTOCOL_VERSION`, like `network`.
An older shell has none, and the site then offers no browser.

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
the tab in the panel ends its page. Temporary chats keep no tab. Outside the desktop app,
restored browser tabs are closed, since nothing can show them.

A tab shows the page's favicon. Main sees each guest's favicon URL, fetches it in the
page's own session (so logged-in and intranet sites work) and hands the page a small
`data:` image. The site's CSP admits no other image origin, and the server's
`/api/favicon` proxy would neither reach those sites nor stay private. A tab's spinner
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

The chat on screen and a page playing sound are never frozen or discarded.
`browserTabs.hold(conversation)` keeps a chat's live pages fully running. Holds outrank
the cap, but a hold alone never reloads a discarded page; the call that needs the page
does.

A renderer reload is one big discard: tabs come back from their addresses, and logins
survive in the partition.
