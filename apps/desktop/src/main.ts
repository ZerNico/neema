import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from "electron";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  attachChrome,
  chromeOptions,
  desktopPlatform,
  isPageSender,
  CHANGE_SERVER,
  CHROME_GET_STATE,
  CHROME_SET_THEME,
  CHROME_SHOW_WINDOW,
  CONNECT,
  CONNECT_CURRENT,
  FIXED_SERVER_ARGUMENT,
  RECOVERY_RETRY,
} from "./chrome.ts";
import {
  configFile,
  isConfiguredOriginUrl,
  isSafeExternalUrl,
  readConfig,
  toOrigin,
  writeConfig,
} from "./config.ts";
import { guardWindowPermissions } from "./window-permissions.ts";
import { makeConnectFlow } from "./connect-flow.ts";
import { attachLoadRecovery } from "./load-recovery.ts";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { DesktopTheme, NoPayload, makeDesktopResponder, refusalReply } from "@chat/desktop-rpc";
import { attachBrowserGuests } from "./browser/guests.ts";
import { BROWSER_PROFILE_ARGUMENT } from "./browser/partitions.ts";
import { browserProfile } from "./browser/profile.ts";
import { browserUserAgent } from "./browser/user-agent.ts";
import { loadSiteGrants, type SiteGrants } from "./browser/site-grants.ts";
import { registerBrowserIpc } from "./browser/ipc.ts";
import { makeExecutions } from "./executions.ts";
import { makeLifecycle } from "./lifecycle.ts";
import { DEV_RESTART } from "./dev-reloader.ts";
import { grantsFile, GrantStore, mountsOf } from "./grants.ts";
import { makeHandlers, type Shell } from "./handlers.ts";
import { loadMachineIdentity, type MachineIdentity } from "./machine.ts";
import { pageHandler } from "./page-ipc.ts";
import { WorkspaceRegistry } from "./workspaces.ts";
import { ComputerSettings, computerSettingsFile } from "./computer-settings.ts";
import { ComputerHost } from "./computer/host.ts";
import { microsandbox } from "./computer/hypervisor.ts";
import { SANDBOX_IMAGE, SANDBOX_INSECURE_REGISTRY } from "./computer/image.ts";
import { computerDialogs } from "./computer/dialogs.ts";
import { RememberedFolders, stillMountable } from "./computer/folder-access.ts";
import {
  SIGN_IN_SCHEME,
  SIGN_IN_TICKET,
  ticketFromArgv,
  ticketFromDeepLink,
  userAgentToken,
} from "./sign-in-link.ts";
import { SYSTEM_LOCALE_ARGUMENT } from "./system-locale.ts";

// Bundled to CJS, because an Electron preload must be CJS while `sandbox: true`.
// `import.meta.url` is empty under that format; `__dirname` is the real thing.
const here = __dirname;
const REQUEST_CHANNEL = "chat-desktop:request";
const platform = desktopPlatform(process.platform);
const connectFile = join(here, "..", "static", "connect.html");
const recoveryFile = join(here, "..", "static", "recovery.html");
const connectUrl = pathToFileURL(connectFile).href;
const recoveryUrl = pathToFileURL(recoveryFile).href;
// Rendered from the SVGs beside them by scripts/render-icons.sh.
const appIconFile = join(here, "..", "static", "icons", "icon.png");
const trayIconFile = join(here, "..", "static", "icons", "trayTemplate.png");
const devReload = process.env.CHAT_DESKTOP_DEV_RELOAD === "1";
// Select the profile before services capture paths or Electron opens a session.
if (devReload && process.env.CHAT_DESKTOP_PROFILE) {
  app.setPath("userData", resolve(process.env.CHAT_DESKTOP_PROFILE));
}
// userData was resolved from the old name at startup, so renaming leaves the profile in place.
app.setName("neema");
// Windows files notifications under this id and sends their clicks to the app
// installed with it; it must match electron-builder's appId.
if (process.platform === "win32") app.setAppUserModelId("app.neema.desktop");
// Browser tabs run on the app-wide default, so it must stay what Electron
// generates (`browser/user-agent.ts`); only our name is taken out. The token
// the server keys the desktop session on goes on the app's own session alone,
// set in `whenReady` before any window exists.
app.userAgentFallback = browserUserAgent(app.userAgentFallback, app.getName());
const windowChrome = new WeakMap<BrowserWindow, ReturnType<typeof attachChrome>>();
const windowRecovery = new WeakMap<BrowserWindow, ReturnType<typeof attachLoadRecovery>>();
const windowBrowsers = new WeakMap<BrowserWindow, ReturnType<typeof attachBrowserGuests>>();
// Loaded with the app; until then nothing counts as allowed, so everything asks.
let siteGrants: SiteGrants | null = null;

/**
 * The shell: a window pointed at one server, plus a bridge only that server's
 * pages can reach.
 *
 * The site is remote code running with a door into this machine, so the origin
 * it was pointed at is checked on every single call rather than once at load.
 * A page that navigates elsewhere, or a frame embedded inside it, gets nothing.
 */

let serverOrigin: string | null = null;
let devOrigin: string | null = null;
let mainWindow: BrowserWindow | null = null;
let connectWindow: BrowserWindow | null = null;
const isRemoteSender = (event: IpcMainInvokeEvent) =>
  isPageSender(
    event,
    mainWindow?.webContents,
    (url) => serverOrigin !== null && toOrigin(url) === serverOrigin,
  );
// Same checks as the rest: the configured origin's main frame only.
const fromPage = (event: IpcMainInvokeEvent) => {
  if (!isRemoteSender(event)) throw new Error("Not allowed from this page.");
};
const onPage = <S extends Schema.Decoder<unknown>>(
  channel: string,
  payload: S,
  run: (input: S["Type"]) => unknown,
  invalid?: string,
) => ipcMain.handle(channel, pageHandler(isRemoteSender, payload, run, invalid));
const isConnectSender = (event: IpcMainInvokeEvent) =>
  isPageSender(event, connectWindow?.webContents, (url) => url === connectUrl);
let tray: Tray | undefined;
let workState = { active: 0, needsApproval: 0 };
const hasWork = () => executions.active > 0 || workState.active > 0 || workState.needsApproval > 0;
let respond: ReturnType<typeof makeDesktopResponder>;
const runExecution = (tag: string, payload: unknown, signal: AbortSignal) =>
  runtime.runPromise(respond(tag, payload), { signal });
// Replaced on a server switch: a disposed instance refuses every later call.
let executions = makeExecutions(runExecution);
const lifecycle = makeLifecycle({
  hide: () => {
    mainWindow?.hide();
    connectWindow?.hide();
  },
  hasWork,
  confirmQuit: async () => {
    const { response } = await dialog.showMessageBox({
      type: "question",
      buttons: ["Keep working", "Quit"],
      defaultId: 0,
      cancelId: 0,
      title: "Quit neema?",
      message: "Work is still active. Quitting stops work on this computer.",
      detail: "Close the window instead to keep working in the background.",
    });
    return response === 1;
  },
  dispose: async () => {
    await stopComputer();
    await executions.dispose();
    await runtime.dispose();
    tray?.destroy();
  },
  quit: () => app.quit(),
  reportError: (cause) => {
    console.error("[desktop] shutdown failed", cause);
    dialog.showErrorBox(
      "Could not stop desktop work",
      "Stopping chats’ computers failed. Check the desktop logs before quitting again.",
    );
  },
});

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    GrantStore.layerAt(grantsFile(app.getPath("userData"))),
    WorkspaceRegistry.layerAt(() => {
      if (serverOrigin === null) throw new Error("No server is configured.");
      return serverOrigin;
    }, app.getPath("userData")),
  ),
);

// Placeholder until whenReady loads the real one; nothing can call
// executionSession before the handlers exist, and those wait for whenReady.
let machine: MachineIdentity = { id: "unknown", name: "Unknown machine" };
// Loaded with the app, before the computer starts or the page can ask.
let computerSettings: ComputerSettings | null = null;
const settings = () => {
  if (computerSettings === null) throw new Error("Settings are not loaded yet.");
  return computerSettings;
};

/**
 * This machine's computer for the connected server: chats' VMs and the connection their calls
 * arrive on. One per server; replaced on a switch, stopped on quit (docs/internals/desktop.md).
 */
let computer: { origin: string; host: ComputerHost } | null = null;
const hypervisor = microsandbox(
  async () => {
    // A folder per profile, so a dev profile and an installed app never share VMs. VM sockets
    // sit about 50 bytes below it and macOS caps a socket path at 104, so off Windows it is a
    // short one in the home folder, like ~/.lima. Read at SDK load.
    const profile = app.getPath("userData");
    process.env.MSB_HOME ??=
      process.platform === "win32"
        ? join(profile, "computer", "runtime")
        : join(homedir(), ".neema", createHash("sha256").update(profile).digest("hex").slice(0, 8));
    return import("microsandbox");
  },
  { insecureRegistry: SANDBOX_INSECURE_REGISTRY },
);
const stopComputer = async () => {
  const current = computer;
  computer = null;
  await current?.host.stop();
};
/** The person's language for the shell's own words: their choice in the page, else the system's. */
const shellLocale = async (origin: string): Promise<"en" | "de"> => {
  const [chosen] = await session.defaultSession.cookies
    .get({ url: origin, name: "language" })
    .catch(() => []);
  const language = chosen?.value ?? app.getPreferredSystemLanguages()[0] ?? "en";
  return language.toLowerCase().startsWith("de") ? "de" : "en";
};
const startComputer = (origin: string) => {
  if (computer?.origin === origin) return;
  void stopComputer();
  const userData = app.getPath("userData");
  const dialogs = computerDialogs({
    window: () => mainWindow,
    locale: () => shellLocale(origin),
    appData: userData,
    agentSocket: () => settings().agentSocket(),
    remembered: new RememberedFolders(
      join(
        userData,
        "computer",
        `remembered-folders-${createHash("sha256").update(origin).digest("hex").slice(0, 16)}.json`,
      ),
    ),
  });
  const host = new ComputerHost({
    origin,
    directory: join(app.getPath("userData"), "computer"),
    image: SANDBOX_IMAGE,
    hypervisor,
    machine,
    fetch: (url, init) => session.defaultSession.fetch(url, init),
    workspace: (conversationId) =>
      runtime.runPromise(
        Effect.flatMap(WorkspaceRegistry, (workspaces) => workspaces.ensure(conversationId)),
      ),
    stillMountable: (mount) => stillMountable(mount.hostPath, app.getPath("userData")),
    folders: async (conversationId) =>
      mountsOf(
        await runtime.runPromise(
          Effect.flatMap(GrantStore, (grants) => grants.lookup({ origin, conversationId })),
        ),
      ),
    // A refused copy (too large, or the branch already has files) leaves the branch's empty.
    cloneWorkspace: (from, to) =>
      runtime.runPromise(
        Effect.all(
          [
            Effect.flatMap(WorkspaceRegistry, (workspaces) => workspaces.clone(from, to)).pipe(
              Effect.ignore,
            ),
            // The same person's folders on the same machine: the branch's history works in them.
            Effect.flatMap(GrantStore, (grants) =>
              Effect.flatMap(grants.lookup({ origin, conversationId: from }), (folders) =>
                Effect.forEach(
                  folders,
                  (folder) =>
                    grants.remember({ origin, conversationId: to }, folder.path, folder.readOnly),
                  { discard: true },
                ),
              ),
            ),
          ],
          { discard: true },
        ),
      ),
    // The chat is gone for good: nothing this machine kept for it outlives it.
    discardWorkspace: async (conversationId) => {
      await runtime.runPromise(
        Effect.all(
          [
            Effect.flatMap(WorkspaceRegistry, (workspaces) =>
              workspaces.discard(conversationId).pipe(Effect.ignore),
            ),
            Effect.flatMap(GrantStore, (grants) => grants.forgetAll({ origin, conversationId })),
          ],
          { discard: true },
        ),
      );
      await forgetChatSites(origin, conversationId).catch((error: unknown) =>
        console.error("[desktop] forgetting a chat's sites failed", error),
      );
    },
    localChats: async () => {
      const [workspaced, attached] = await runtime.runPromise(
        Effect.all([
          Effect.flatMap(WorkspaceRegistry, (workspaces) => workspaces.chats()),
          Effect.flatMap(GrantStore, (grants) => grants.chats(origin)),
        ]),
      );
      return [...new Set([...workspaced, ...attached])];
    },
    agentSocket: () => settings().agentSocket(),
    remote: () => settings().get().remote,
    ask: dialogs,
    attach: async (conversationId, hostPath) => {
      const key = { origin, conversationId };
      const attached = await runtime.runPromise(
        Effect.flatMap(GrantStore, (grants) => grants.lookup(key)),
      );
      const name = basename(hostPath);
      if (attached.some((folder) => folder.path === hostPath)) return { name };
      // A folder is addressed by its name in the chat, so two may not share one.
      if (attached.some((folder) => basename(folder.path) === name))
        return { refused: `A folder named ${name} is already attached to this chat.` };
      await runtime.runPromise(
        Effect.flatMap(GrantStore, (grants) => grants.remember(key, hostPath)),
      );
      return { name };
    },
    log: (message) => console.log(`[desktop] ${message}`),
  });
  computer = { origin, host };
  void host.start().catch((error: unknown) => console.error("[desktop] computer failed", error));
};
/** Folder attach and detach happen in the page; the server hears the chat's new folder names. */
const FOLDER_CHANGES = new Set(["chooseFolder", "detachFolder"]);

/** Forgets the sites one chat's browser was allowed, and its in-memory browser profile. */
const forgetChatSites = async (origin: string, conversationId: string) => {
  await siteGrants?.forgetChat(origin, conversationId);
  // A temporary chat's in-memory browser profile would otherwise live as long as the app.
  const browser = mainWindow && windowBrowsers.get(mainWindow);
  await browser?.releaseChat(conversationId);
};

const desktopShell: Shell = {
  appData: app.getPath("userData"),
  // Requests only arrive from the configured origin's page (`isPageSender`),
  // so by the time a handler runs there is one.
  serverOrigin: () => {
    if (serverOrigin === null) throw new Error("No server is configured.");
    return serverOrigin;
  },
  // Minted on first launch, persisted beside the grants; a reinstall gets a
  // fresh one, which the site then treats exactly like a foreign machine.
  executionSession: () => ({
    id: executions.id,
    machineId: machine.id,
    machineName: machine.name,
  }),
  cancelCall: (callId) => executions.cancelCall(callId),
  computer: () =>
    computer?.host.status() ?? { status: "unavailable", reason: "No server is connected." },
  get settings() {
    return settings();
  },
  remoteChanged: () => computer?.host.remoteChanged(),
  setWorkState: (state) => {
    workState = state;
    const status =
      state.needsApproval > 0
        ? `${state.needsApproval} waiting for approval`
        : state.active > 0
          ? `${state.active} active`
          : "No active work";
    tray?.setToolTip(`neema: ${status}`);
    app.dock?.setBadge(state.needsApproval > 0 ? String(state.needsApproval) : "");
  },
  pickDirectory: async () => {
    const parent = mainWindow;
    const result = await (parent
      ? dialog.showOpenDialog(parent, { properties: ["openDirectory"] })
      : dialog.showOpenDialog({ properties: ["openDirectory"] }));
    return result.canceled ? null : (result.filePaths[0] ?? null);
  },
  // Electron's own shell, not ours. `showItemInFolder` reports nothing, and
  // `openPath` answers with the empty string when the system took the file.
  revealPath: async (absolute, mode) => {
    if (mode === "reveal") {
      shell.showItemInFolder(absolute);
      return null;
    }
    return (await shell.openPath(absolute)) || null;
  },
};

/** What the chooser prefills; null on first run. */
let connectCurrent: string | null = null;
let configPath: string | null = null;
const hasMainWindow = () => mainWindow !== null && !mainWindow.isDestroyed();

const openConnectWindow = (current: string | null) => {
  const window = new BrowserWindow({
    ...chromeOptions(platform, nativeTheme.shouldUseDarkColors),
    width: 520,
    height: 360,
    resizable: false,
    title: "Connect",
    icon: appIconFile,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      preload: join(here, "connect-preload.cjs"),
    },
  });
  connectWindow = window;
  connectCurrent = current;
  windowChrome.set(window, attachChrome(window, nativeTheme, platform));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // Cancelling the chooser leaves the main window as it was. On first run
  // there is none, so the chooser only hides, as every window does, and the
  // dock or tray brings it back.
  window.on("close", (event) => {
    if (!hasMainWindow()) lifecycle.close(event);
  });
  window.on("closed", () => {
    if (connectWindow === window) connectWindow = null;
  });
  void window.loadFile(connectFile).catch((cause: unknown) => {
    if (!window.isDestroyed()) console.error("[desktop] connect page failed", cause);
  });
  return window;
};

/**
 * Interrupted copies and what older versions left in the workspaces root accumulate.
 * Cleanup runs once the origin-scoped root is known, both at startup and after
 * switching servers.
 */
const sweepTransientWorkspaces = () => {
  if (serverOrigin === null) return;
  void runtime
    .runPromise(
      Effect.gen(function* () {
        const workspaces = yield* WorkspaceRegistry;
        yield* workspaces.sweepTransient();
      }),
    )
    .catch((cause: unknown) => console.error("[desktop] workspace cleanup failed", cause));
};

const connectFlow = makeConnectFlow({
  fixedServer: () => devOrigin !== null,
  hasMain: hasMainWindow,
  hasWork,
  currentOrigin: () => serverOrigin,
  confirmSwitch: async () => {
    const { response } = await dialog.showMessageBox({
      type: "question",
      buttons: ["Keep working", "Switch server"],
      defaultId: 0,
      cancelId: 0,
      title: "Switch server?",
      message: "Work is still active. Switching servers stops work on this computer.",
      detail: "Stay on this server to keep working.",
    });
    return response === 1;
  },
  // The computer and browser executions belong to the server that started them.
  // The runtime (folders, workspaces) is per machine and stays up; both are
  // keyed by origin, so nothing from this server is visible on the next.
  disposeWork: async () => {
    await stopComputer();
    await executions.dispose();
    executions = makeExecutions(runExecution);
    desktopShell.setWorkState({ active: 0, needsApproval: 0 });
  },
  writeConfig: async (origin) => {
    if (configPath === null) throw new Error("No config path.");
    await writeConfig(configPath, { serverUrl: origin });
  },
  chooser: () => {
    const window = connectWindow;
    if (!window || window.isDestroyed()) return null;
    return {
      focus: () => {
        window.show();
        window.focus();
      },
      destroy: () => window.destroy(),
    };
  },
  openConnect: (current) => {
    openConnectWindow(current);
  },
  openMain: (origin) => {
    serverOrigin = origin;
    sweepTransientWorkspaces();
    mainWindow = openMainWindow(origin);
    startComputer(origin);
  },
  closeMain: () => {
    const window = mainWindow;
    mainWindow = null;
    window?.destroy();
  },
});

const openMainWindow = (origin: string) => {
  const profile = browserProfile(origin);
  const window = new BrowserWindow({
    ...chromeOptions(platform, nativeTheme.shouldUseDarkColors),
    width: 1280,
    height: 860,
    icon: appIconFile,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      preload: join(here, "preload.cjs"),
      // The page embeds browser tabs; `attachBrowserGuests` decides every one.
      webviewTag: true,
      // Known before the window exists, so the page hides the switch instead
      // of offering one that would only be refused. The browser profile is
      // named here too, since it belongs to this origin.
      additionalArguments: [
        `${BROWSER_PROFILE_ARGUMENT}=${profile}`,
        `${SYSTEM_LOCALE_ARGUMENT}=${app.getSystemLocale()}`,
        ...(devOrigin === null ? [] : [FIXED_SERVER_ARGUMENT]),
      ],
    },
  });

  mainWindow = window;
  windowChrome.set(window, attachChrome(window, nativeTheme, platform));
  const recovery = attachLoadRecovery(window, origin, recoveryFile, (cause) =>
    console.error("[desktop] recovery page failed", cause),
  );
  windowRecovery.set(window, recovery);
  windowBrowsers.set(
    window,
    attachBrowserGuests(
      window,
      profile,
      () => toOrigin(window.webContents.getURL()) === origin,
      (conversationId, url) => siteGrants?.allowed(origin, conversationId, url) ?? false,
      // A file the model's page downloaded, into that chat's workspace on this machine.
      (conversationId, fileName, bytes, signal) =>
        runtime.runPromise(
          Effect.flatMap(WorkspaceRegistry, (workspaces) =>
            Effect.map(workspaces.landFile(conversationId, fileName, bytes, signal), (landed) =>
              join(workspaces.path(conversationId), landed.name),
            ),
          ),
        ),
    ),
  );

  // Navigation is pinned to the configured origin. Anything else opens in the
  // real browser, where it has no bridge, rather than inside a window that does.
  // Only http(s) is handed to the OS: file: and custom schemes are a local-exec path.
  window.webContents.on("will-navigate", (event, url) => {
    if (toOrigin(url) === origin) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  window.on("close", (event) => lifecycle.close(event));
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.on("did-finish-load", flushPendingTicket);
  window.webContents.on("did-navigate", flushPendingTicket);
  void recovery.retry();
  return window;
};

const start = async () => {
  console.log(`[desktop] build ${__BUILD_STAMP__}`);
  // A developer points the shell at a dev server without going through the
  // connect window or touching the stored choice, which stays the real one.
  devOrigin = process.env.CHAT_DESKTOP_SERVER ? toOrigin(process.env.CHAT_DESKTOP_SERVER) : null;
  if (devOrigin) {
    serverOrigin = devOrigin;
    mainWindow = openMainWindow(devOrigin);
    startComputer(devOrigin);
    return;
  }
  configPath = configFile(app.getPath("userData"));
  const config = await readConfig(configPath);
  if (config === null) {
    openConnectWindow(null);
    return;
  }
  serverOrigin = config.serverUrl;
  mainWindow = openMainWindow(config.serverUrl);
  startComputer(config.serverUrl);
};

/** Menu entry; a refusal here is unexpected, since the entry is absent under a pinned server. */
const chooseServer = async () => {
  const outcome = await connectFlow.openChooser();
  if (!outcome.ok) dialog.showErrorBox("Cannot change server", outcome.message);
};

const restoreWindow = () => {
  if ((!mainWindow || mainWindow.isDestroyed()) && serverOrigin !== null)
    mainWindow = openMainWindow(serverOrigin);
  const window = mainWindow ?? BrowserWindow.getAllWindows()[0];
  if (window?.isMinimized()) window.restore();
  window?.show();
  window?.focus();
};

/** A ticket that arrives before the window exists (macOS fires open-url early) waits for it. */
let pendingTicket: string | null = null;

const flushPendingTicket = () => {
  if (pendingTicket === null) return;
  const contents = mainWindow?.webContents;
  if (!contents || contents.isLoadingMainFrame()) return;
  if (!isConfiguredOriginUrl(contents.getURL(), serverOrigin)) return;
  const ticket = pendingTicket;
  pendingTicket = null;
  contents.send(SIGN_IN_TICKET, ticket);
};

/** A sign-in ticket from the browser reaches the configured origin page only. */
const deliverTicket = (ticket: string) => {
  pendingTicket = ticket;
  restoreWindow();
  flushPendingTicket();
};

app.on("open-url", (event, url) => {
  const ticket = ticketFromDeepLink(url);
  if (ticket === null) return;
  event.preventDefault();
  deliverTicket(ticket);
});

// The dev supervisor relaunches on every rebuild, so a stranded old instance
// must not be able to hold the lock against the new one.
const primaryInstance = devReload || app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
else if (!devReload) {
  app.on("second-instance", (_event, argv) => {
    const ticket = ticketFromArgv(argv);
    if (ticket === null) restoreWindow();
    else deliverTicket(ticket);
  });
  // Windows and Linux launch the app with the link as an argument when it is
  // not already running; only a running instance gets `second-instance`.
  const coldStart = ticketFromArgv(process.argv);
  if (coldStart !== null) pendingTicket = coldStart;
  if (process.defaultApp && process.argv[1])
    app.setAsDefaultProtocolClient(SIGN_IN_SCHEME, process.execPath, [resolve(process.argv[1])]);
  else app.setAsDefaultProtocolClient(SIGN_IN_SCHEME);
}

// The View menu acts on the app window itself. Electron's own roles act on
// whatever has focus, which can be a page in the side panel's browser, so
// reloading or opening developer tools would reach that page instead.
const windowContents = () => (BrowserWindow.getFocusedWindow() ?? mainWindow)?.webContents;
const zoom = (step: number | null) => {
  const contents = windowContents();
  if (contents) contents.setZoomLevel(step === null ? 0 : contents.getZoomLevel() + step);
};
const viewMenu = (): MenuItemConstructorOptions => {
  return {
    label: "View",
    submenu: [
      { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => windowContents()?.reload() },
      {
        label: "Force Reload",
        accelerator: "Shift+CmdOrCtrl+R",
        click: () => windowContents()?.reloadIgnoringCache(),
      },
      {
        label: "Toggle Developer Tools",
        accelerator: process.platform === "darwin" ? "Alt+Cmd+I" : "Ctrl+Shift+I",
        click: () => windowContents()?.toggleDevTools(),
      },
      { type: "separator" },
      { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => zoom(null) },
      { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", click: () => zoom(0.5) },
      { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => zoom(-0.5) },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };
};

void app.whenReady().then(async () => {
  if (!primaryInstance) return;
  session.defaultSession.setUserAgent(
    `${app.userAgentFallback} ${userAgentToken(__BUILD_STAMP__)}`,
  );
  guardWindowPermissions(session.defaultSession, () => serverOrigin);
  machine = await loadMachineIdentity(app.getPath("userData"));
  computerSettings = await ComputerSettings.load(computerSettingsFile(app.getPath("userData")));
  // The process sandbox's grants, from before chats had computers.
  void rm(join(app.getPath("userData"), "network-grants"), { recursive: true, force: true });
  siteGrants = await loadSiteGrants(app.getPath("userData"));
  const handlers = await runtime.runPromise(makeHandlers(desktopShell));
  respond = makeDesktopResponder(handlers);
  sweepTransientWorkspaces();
  // The pinned dev server is decided from the environment, before start() runs.
  const pinned = Boolean(process.env.CHAT_DESKTOP_SERVER);
  const actions = [
    { label: "Show neema", click: restoreWindow },
    ...(pinned
      ? []
      : [{ label: "Connect to a different server…", click: () => void chooseServer() }]),
    { label: "Quit neema", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
  ];
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: "neema", submenu: actions },
      { role: "editMenu" },
      viewMenu(),
      { role: "windowMenu" },
    ]),
  );
  app.dock?.setMenu(Menu.buildFromTemplate(actions));
  // Unpackaged, the dock would otherwise show Electron.app's own icon.
  app.dock?.setIcon(appIconFile);
  // macOS recolours the black template glyph for the menu bar; elsewhere it
  // would vanish on a dark taskbar, so the tray gets the full-colour icon.
  tray = new Tray(
    process.platform === "darwin"
      ? trayIconFile
      : nativeImage.createFromPath(appIconFile).resize({ width: 32, height: 32 }),
  );
  tray.setToolTip("neema");
  tray.setContextMenu(Menu.buildFromTemplate(actions));
  tray.on("click", restoreWindow);

  ipcMain.handle(CHROME_GET_STATE, (event) => {
    const window =
      isRemoteSender(event) ||
      isPageSender(event, mainWindow?.webContents, (url) => url === recoveryUrl)
        ? mainWindow
        : isPageSender(event, connectWindow?.webContents, (url) => url === connectUrl)
          ? connectWindow
          : null;
    const chrome = window && windowChrome.get(window);
    if (!chrome) throw new Error("Not allowed from this page.");
    return chrome.getState();
  });
  // Every onPage channel is the configured page's alone, and each payload is decoded, never cast.
  onPage(CHROME_SET_THEME, DesktopTheme, (theme) => {
    if (!mainWindow) throw new Error("Not allowed from this page.");
    windowChrome.get(mainWindow)?.setTheme(theme);
  });
  // Only the server's page asks, when someone clicks one of its notifications.
  onPage(CHROME_SHOW_WINDOW, NoPayload, () => restoreWindow());
  registerBrowserIpc({
    page: fromPage,
    guests: (event) => {
      fromPage(event);
      const browser = mainWindow && windowBrowsers.get(mainWindow);
      if (!browser) throw new Error("No browser in this window.");
      return browser;
    },
    grants: (event) => {
      fromPage(event);
      if (!serverOrigin || !siteGrants) throw new Error("Not allowed from this page.");
      return { grants: siteGrants, origin: serverOrigin };
    },
  });
  ipcMain.handle(RECOVERY_RETRY, async (event) => {
    if (!isPageSender(event, mainWindow?.webContents, (url) => url === recoveryUrl) || !mainWindow)
      throw new Error("Not allowed from this page.");
    await windowRecovery.get(mainWindow)?.retry();
  });
  // The page only asks for the chooser. The address is typed there, so a
  // compromised site cannot redirect the bridge at another origin.
  ipcMain.handle(CHANGE_SERVER, (event) => {
    if (
      !isRemoteSender(event) &&
      !isPageSender(event, mainWindow?.webContents, (url) => url === recoveryUrl)
    )
      return { ok: false, message: "Not allowed from this page." };
    return connectFlow.openChooser();
  });
  ipcMain.handle(CONNECT_CURRENT, (event) => {
    if (!isConnectSender(event)) throw new Error("Not allowed from this page.");
    return connectCurrent;
  });
  ipcMain.handle(CONNECT, (event, candidate: unknown) => {
    if (!isConnectSender(event)) return { ok: false, message: "Not allowed from this page." };
    return connectFlow.connect(candidate);
  });

  ipcMain.handle(REQUEST_CHANNEL, async (event, message: unknown) => {
    // Re-checked per call, not once at load: a window that has navigated, or a
    // frame inside it, must not inherit the door the configured origin has.
    if (!isRemoteSender(event)) return refusalReply("failed", "Not allowed from this page.");
    const { tag, payload } = (message ?? {}) as { tag?: unknown; payload?: unknown };
    if (typeof tag !== "string") return refusalReply("failed", "Malformed request.");
    const reply = await executions.request(tag, payload);
    const conversationId = (payload as { conversationId?: unknown } | null)?.conversationId;
    if (FOLDER_CHANGES.has(tag) && typeof conversationId === "string")
      void computer?.host.foldersChanged(conversationId);
    return reply;
  });

  if (devReload && process.send) {
    // Only the owning dev supervisor can request a restart, never the web page.
    const restart = () => {
      void lifecycle.beforeQuit({ preventDefault() {} }, { confirm: false });
    };
    process.on("message", (message) => {
      if (message === DEV_RESTART) restart();
    });
    process.on("disconnect", restart);
    process.on("SIGTERM", restart);
    process.on("SIGINT", restart);
  }

  await start();
  // A ticket that arrived before the window existed is handed over now.
  flushPendingTicket();

  app.on("activate", restoreWindow);
});

// Hidden windows retain their renderer and work on every supported platform.
app.on("window-all-closed", () => {});
app.on("before-quit", (event) => {
  void lifecycle.beforeQuit(event);
});
