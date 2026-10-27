# Using the person's apps

Planned. A chat may operate apps on the person's own machine: look at one app's window, click,
type, scroll. It is the one feature that acts outside the chat's VM, so what it may touch is
narrow and the person sees and can stop everything it does. Web pages are the embedded
browser's ([browser](browser.md)), and commands and files the chat's computer's
([desktop](desktop.md)). This is for apps that have neither: Excel, Finder, Mail, a design
tool, a company's desktop client.

"Computer" stays the chat's VM. This is **app use**, its tools are the `app` family, and
"the machine" is the desktop install, as in [desktop](desktop.md).

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

A lazy family, like the browser's: named in the catalogue, loaded on first need.

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

Every action returns a fresh look unless it asks not to, so the model sees what it caused.

## Consent is per app

- **The person allows an app, not a click.** The first call that touches an app asks at the
  machine, in a native dialog like `request_folder`'s: "Let this chat use Microsoft Excel?"
  with **Allow once**, **Allow in this chat** and **Always allow**. Always-allowed apps are
  listed in Settings › This computer, removable there.
- **Inside an allowed app, actions do not ask one by one.** A card per click would make the
  feature useless. The chat's permission level does not apply to app actions. The model is
  told to stop and hand over before sending, paying, deleting, or anything signed in as the
  person that cannot be undone.
- **Asked at the machine, like folders.** Allowing an app needs the person there. From
  another device the chat may use only apps already always allowed, and only when the
  machine allows remote use.
- **Some apps are never offered**, whatever the person allows: terminals (Terminal, iTerm,
  Windows Terminal, PowerShell, cmd), password managers and Keychain Access, System Settings
  and Windows Settings, the registry editor, and neema itself. The model can run commands in
  the chat's VM, so a terminal on the real machine would sidestep everything there.
- **It never answers the system's own questions.** macOS authorization dialogs
  (SecurityAgent), Windows UAC prompts and permission prompts are out of reach, by process,
  not by politeness. Logins, two-factor codes and payments hand over to the person.

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

|                | macOS                                                                    | Windows                                                      |
| -------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Structure      | AX                                                                       | UI Automation                                                |
| Window picture | ScreenCaptureKit                                                         | Windows.Graphics.Capture                                     |
| Acting         | AX actions in the background, events posted to the app where AX has none | UIA patterns without focus, real input with the app in front |
| While working  | the person keeps their cursor and front app                              | the app comes to the front and input is real                 |

On Windows the person is told that app use takes over the screen while it runs. What UIA
can do without focus (Invoke, Value, Toggle, Selection) still runs without taking over.

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
- **Started by the desktop app, never on its own.** It holds no state beyond the latest look
  and exits with the app.
- **The machine's permissions, granted once.** macOS asks for Screen Recording and
  Accessibility for neema, never for the driver: TCC charges a child process to the app that
  spawned it, so an unsigned driver runs on its parent's grants. That holds only while
  it is spawned directly. Launched through LaunchServices (`open`) it would become its own
  responsible process and need grants of its own. Under `pnpm dev` the responsible app is the
  terminal that started it.
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

1. Done: the protocol, the outline, and the macOS driver's look and press, proven by
   `real-driver.test.ts` on a fully covered Calculator that stays in the background. A look
   takes about 300 ms on a small app and 700 ms on Outlook.
2. The tools against the protocol, consent, the remaining actions. Outlines need better
   pruning: Outlook's fills the 12,000-character budget.
3. The floating view, the cursor, pausing on the person's input.
4. The Windows driver on the same protocol.
