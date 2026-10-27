# Using the person's apps

Planned. A chat may operate apps on the person's own machine: look at one app's window, click,
type, scroll. It is the one feature that acts outside the chat's VM, so what it may touch is
narrow and the person sees and can stop everything it does. Web pages are the embedded
browser's ([browser](browser.md)), and commands and files the chat's computer's
([desktop](desktop.md)). This is for apps that have neither: Excel, Finder, Mail, a design
tool, a company's desktop client.

"Computer" stays the chat's VM. This is **app use**, its tools are the `app` family, and
"the machine" is the desktop install, as in [desktop](desktop.md). People call it computer use,
and the model is told so in its catalogue line and hint: asked for "computer use" without that,
it reached for the browser.

## Our own tools, not a provider's

Anthropic and OpenAI each ship a native computer tool their models are trained on. We use
ordinary function tools instead, so any vision model can drive apps, the Hermes polyfill
included, and the tools can do better than pixels:

- **A look is a picture and an outline.** macOS and Windows expose every app's interface as
  an accessibility tree (AX on macOS, UI Automation on Windows): buttons, fields, menus,
  cells, each with a role, a name, a value and the actions it supports. `app_look` returns a
  screenshot of the app's window and a numbered outline of that tree (`e12 button "Save"`,
  `e31 cell B4 "1200"`), the same pattern as `browser_snapshot`, so the model learns one way
  of working.
- **Acting by reference, or by pixel.** Every action takes either a reference from the latest
  look, which is reliable, cheap and works in the background, or a coordinate on that look's
  screenshot, for canvases, games and apps whose accessibility is thin. The model sees both
  in one look and picks per element. References are valid for the look that made them,
  as the browser's are for their snapshot.
- **Precision without a bigger picture.** `app_zoom` returns part of the last look at full
  resolution. Screenshots stay at most 1280 px on the long edge, and the desktop app maps
  coordinates back to the real window.

The price is that the native tools' models are tuned to their exact shape. The outline makes
up for most of it, and the tool names and descriptions follow what those models expect.

## The tools

A lazy family, like the browser's: named in the catalogue, loaded on first need. Offered once
the person has a Mac connected, the one platform with a driver. They are desktop tools in
family and envelope, run by the chat's machine like the computer's, but never touch its VM, so
a machine whose VM is still downloading or impossible can still use its apps.

| Tool         | Does                                                                 |
| ------------ | -------------------------------------------------------------------- |
| `app_list`   | Running apps and their windows, and which this chat may use          |
| `app_open`   | Opens or brings forward an app this chat may use                     |
| `app_look`   | A screenshot of the app's window and its numbered outline            |
| `app_click`  | Clicks a reference or a point, left, right or double, with modifiers |
| `app_type`   | Types text into a reference or the focused field                     |
| `app_key`    | Presses keys or a shortcut, `cmd+s`, `Return`                        |
| `app_scroll` | Scrolls a reference or a point                                       |
| `app_drag`   | Drags from one point or reference to another                         |
| `app_zoom`   | Part of the last look at full resolution                             |

Every action returns a fresh look, after a short pause for the app to redraw, so the model sees
what it caused. Coordinates are the picture's pixels, scaled to window points by the chat's
latest look.

## Consent is per app

- **The person allows an app, not a click.** The first call that touches an app asks at the
  machine, in a native dialog like `request_folder`'s: "Let this chat use Microsoft Excel?"
  with **Allow in this chat** and **Always allow**. No "once": a grant for one call would ask
  again before every click. The app is named as macOS knows it before anything starts it.
  Answers live on the machine, per server, like folder and site grants, so the server never
  learns which apps a person trusts; a chat's go with it. Always-allowed apps are to be listed
  in Settings › This computer, removable there.
- **Inside an allowed app, actions do not ask one by one.** A card per click would make the
  feature useless. The chat's permission level does not apply to app actions. The model is
  told to stop and hand over before sending, paying, deleting, or anything signed in as the
  person that cannot be undone.
- **Asked at the machine, like folders.** Allowing an app needs the person there. The server
  tells the machine whether a call's message came from it (`local`, judged by the sending
  session), since the machine cannot know. From another device the chat may use only apps
  already always allowed, and only when the machine allows remote use.
- **Some apps are never offered**, whatever the person allows: terminals (Terminal, iTerm,
  Windows Terminal, PowerShell, cmd), password managers and Keychain Access, System Settings
  and Windows Settings, the registry editor, and neema itself, known as the driver's parent,
  since in development it shares Electron's bundle id with every other Electron app. The model can run commands in
  the chat's VM, so a terminal on the real machine would sidestep everything there.
- **It never answers the system's own questions.** macOS authorization dialogs
  (SecurityAgent), Windows UAC prompts and permission prompts are out of reach, by process,
  not by politeness. Logins, two-factor codes and payments hand over to the person.

## Permissions are a guided step

App use needs Accessibility and Screen Recording for neema. On macOS 26 the system's prompts
no longer add a new app to either list (measured by agent-desktop), so the person must drag
neema in. The driver shows a small panel for that, pinned under the list in System Settings,
with neema's bundle as the thing to drag, as LobeHub does (`Guide.swift`). It never takes
focus, follows the window, hides when Settings is not in front, and answers once the grant
shows. Screen Recording is read from other apps' window titles becoming readable, since the
check meant for it keeps its first answer until the process ends; it counts only after neema
reopens, which neema then offers. A cancel overtakes the guide it ends, numbered so it also
ends one not yet on screen. It runs only for a message sent from the machine itself.

## Only the allowed app is seen

A look captures that app's own windows, never the whole screen (ScreenCaptureKit on macOS,
Windows.Graphics.Capture on Windows, both work on a covered window). Other apps, the desktop
and notifications never reach the model. A look is a working file of the answer, shown to a
vision model and not stored, like the browser's screenshots, unless the model shares one.

## The person stays in control

- **A floating view.** While a chat uses an app, a small always-on-top window shows that
  app's window live, a few frames a second, with what is happening ("Clicking Save") and a
  Stop button. It opens from the chat too, as a panel tab.
- **Its own cursor.** Where neema clicks, a small marked cursor is drawn over the app,
  separate from the person's.
- **The person's input wins.** Any keyboard or mouse input from the person pauses app use
  until they resume it from the floating view. A global shortcut stops it.
- **Stop is Stop.** The answer's Stop, the floating view's and the shortcut all end the
  call, and the driver drops anything queued.

## macOS and Windows differ in one way

|                | macOS                                                                       | Windows                                                      |
| -------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Structure      | AX                                                                          | UI Automation                                                |
| Window picture | ScreenCaptureKit                                                            | Windows.Graphics.Capture                                     |
| Acting         | AX actions, and window server input to the covered window where AX has none | UIA patterns without focus, real input with the app in front |
| While working  | the person keeps their cursor and front app                                 | the app comes to the front and input is real                 |

On Windows the person is told that app use takes over the screen while it runs. What UIA
can do without focus (Invoke, Value, Toggle, Selection) still runs without taking over.

### Background input on macOS is private API, on purpose

Keys and text reach a covered app through public per-process posting. A click does not: the
window server delivers it to whatever lies under the real cursor. Codex's helper and Cua's
driver both use SkyLight for this, and so does ours (`SkyLight.swift`, after cua-driver and
yabai): a focus record makes the window take input without raising it, a stamped move primes
where the app thinks the cursor is, and the press and release go to the process with the
window's id. Only the target gets a focus record. Defocusing the person's front app left their
window deaf to typing until they clicked it, which Cua shipped and had to undo.

Every symbol is looked up by name. A macOS release that drops one turns `background` false in
`permissions`, and coordinate input falls back to the public route, which most apps ignore.
References keep working either way, since a press is accessibility, not a click.

### Chromium and Electron

Chrome and every Electron app need three things more, each measured against an Electron page
that reports what it receives (`fixtures/chromium-target.cjs`):

- **Their page is not in the tree until asked for.** Reading the application's role turns it
  on at once, which Apple advises for assistive tools and Chromium implements. The two older
  switches follow: Electron 45 says yes to `AXManualAccessibility` and stays off, and Chrome
  takes `AXEnhancedUserInterface` only after two quiet seconds, restarted whenever anything
  flips it, as window managers do. The driver asks once per process and waits for the page,
  turning its run loop: a page asked for from a sleeping thread never came.
- **Their first click into an inactive window is swallowed.** A press and release at (-1, -1),
  which nothing hit-tests, passes Chromium's user-activation check first; the events carry
  screen points and a gesture phase (after cua-driver).
- **A press by reference does nothing.** In the mode the driver turns on, the page answers an
  accessibility press with success and ignores it, so a reference is clicked at its centre.

Cua's `_AXObserverAddNotificationAndCheckRemote`, for keeping a covered Electron window's tree
live, no longer exists in macOS 26; nothing here needed it.

## The drivers

The desktop app cannot reach AX or UIA from Electron, so each platform has a small native
**app driver** bundled with it: Swift on macOS (`apps/desktop/native/app-driver/macos`), Rust
on Windows (`…/windows`). Both implement one protocol, JSON lines over stdio, specified in
`apps/desktop/src/app-use/protocol.ts`.

- **Drivers are thin.** A driver lists apps, captures a window, walks its tree and performs
  actions. It sends the whole tree as a flat preorder list of nodes, with roles mapped onto
  one shared vocabulary and frames in window points. What the model reads, the numbered
  outline, its pruning and its budget, is built once in `outline.ts`, which also turns
  outline references into node ids and picture pixels into points. A second platform
  is a second driver, not a second outline.
- **Node ids last one look.** The driver keeps the elements of its latest look and refuses an
  id from an older one.
- **One driver per desktop app**, shared by whichever server it serves, with calls one at a
  time. replayd, which every macOS capture path goes through (ScreenCaptureKit, SkyLight and
  even `CGWindowListCreateImage` on macOS 26), mixes up processes of one identity: two drivers
  capturing stalled every capture of both until they were gone, while two differently named
  copies captured side by side (measured). Codex likewise has one service. The host keeps each
  chat's look, keyed by server and chat, and an action whose chat no longer holds the driver's
  look looks again instead of acting on another chat's references.
- **Started by the desktop app, never on its own.** It holds no state beyond the latest look
  and exits when its input closes, after answering what was already asked, within two
  seconds even if a call is stuck. An orphan once kept a stalled capture spinning for minutes.
- **Captures are bounded.** ScreenCaptureKit gets two seconds, then the window server's own
  copy through SkyLight three, as cua-driver reads windows on another Space. A capture that
  never answers fails the look; it does not hold every later call.
- **The machine's permissions, granted once.** macOS asks for Screen Recording and
  Accessibility for neema, never for the driver: TCC charges a child process to the app that
  spawned it, so an unsigned driver runs on its parent's grants. That holds only while
  it is spawned directly. Launched through LaunchServices (`open`) it would become its own
  responsible process and need grants of its own. Under `pnpm dev` the responsible app is the
  terminal that started it.
- **Direct capture needs one more approval.** Since macOS 15, the first direct capture by an
  app makes replayd show "… is requesting to bypass the system private window picker", an
  alert that takes the front and the keyboard, and records the answer per app bundle. Every
  capture path raises it (cua-driver's measurement). It is to be asked for with the other
  permissions, never in the middle of a chat.
- **A window server connection, no Dock icon.** ScreenCaptureKit asserts without a
  connection, so the macOS driver starts a shared application with the prohibited activation
  policy.
- **The off-limits list lives in each driver**, by bundle id or executable, so a confused
  caller cannot reach those apps either.
- **Calls take the machine route.** The server decides them like any computer call and sends
  them over the machine connection. The host hands them to the driver instead of the VM.

## Not now

- **Working while the machine is locked.** On macOS it needs an authorization plug-in in the
  unlock flow, installed with admin rights. Apple's engineers note such plug-ins move the Mac
  to the legacy unlock path, without Touch ID, and Sonoma, Sequoia and Tahoe each broke
  something there. It would also have to obtain the person's login to unlock. Windows has no
  supported equivalent. Revisit once app use has proven itself.
- **Linux desktops.** AT-SPI exists, but Wayland's capture and input rules differ by
  compositor.
- **Several chats in one app at once.** One chat drives an app at a time. A second waits.

## Order of work

1. Done: the protocol, the outline and the macOS driver, every action in the background on
   AppKit and Chromium (`real-driver.test.ts`). A look takes about 300 ms on a small app and
   700 ms on Outlook.
2. Done: the tools, the machine route, consent and the host (`host.test.ts`). Left: the
   always-allowed list in Settings, and better outline pruning (Outlook's fills the
   12,000-character budget).
3. Done: the permission guide. Left: proving with a packaged build that a list accepts the
   dropped bundle, and asking for the direct-capture approval in the same step.
4. The floating view, the cursor, pausing on the person's input.
5. The Windows driver on the same protocol.
