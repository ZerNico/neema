import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  shell,
  Tray,
  type IpcMainInvokeEvent,
} from "electron";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  attachChrome,
  chromeOptions,
  desktopPlatform,
  isPageSender,
  CHANGE_SERVER,
  CHROME_GET_STATE,
  CHROME_SET_THEME,
  CONNECT,
  CONNECT_CURRENT,
  FIXED_SERVER_ARGUMENT,
  RECOVERY_RETRY,
} from "./chrome.ts";
import { makeConnectFlow } from "./connect-flow.ts";
import { attachLoadRecovery } from "./load-recovery.ts";
import { Layer, ManagedRuntime } from "effect";
import { makeDesktopResponder, refusalReply } from "@chat/desktop-rpc";
import { makeExecutions } from "./executions.ts";
import { makeLifecycle } from "./lifecycle.ts";
import { DEV_RESTART } from "./dev-reloader.ts";
import { disposeOwnedProcesses } from "./process.ts";
import { configFile, readConfig, toOrigin, writeConfig } from "./config.ts";
import { grantsFile, GrantStore } from "./grants.ts";
import { makeHandlers, type Shell } from "./handlers.ts";
import { Sandbox } from "./sandbox.ts";
import {
  SIGN_IN_SCHEME,
  SIGN_IN_TICKET,
  ticketFromArgv,
  ticketFromDeepLink,
  userAgentToken,
} from "./sign-in-link.ts";

// Bundled to CJS, because an Electron preload must be CJS while `sandbox: true`.
// `import.meta.url` is empty under that format; `__dirname` is the real thing.
const here = __dirname;
const REQUEST_CHANNEL = "chat-desktop:request";
const platform = desktopPlatform(process.platform);
const connectFile = join(here, "..", "static", "connect.html");
const recoveryFile = join(here, "..", "static", "recovery.html");
const connectUrl = pathToFileURL(connectFile).href;
const recoveryUrl = pathToFileURL(recoveryFile).href;
const devReload = process.env.CHAT_DESKTOP_DEV_RELOAD === "1";
// The server keys the desktop session policy on this token; set before any window exists.
app.userAgentFallback = `${app.userAgentFallback} ${userAgentToken(__BUILD_STAMP__)}`;
const windowChrome = new WeakMap<BrowserWindow, ReturnType<typeof attachChrome>>();
const windowRecovery = new WeakMap<BrowserWindow, ReturnType<typeof attachLoadRecovery>>();

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
      title: "Quit Chat?",
      message: "Work is still active. Quitting stops work on this computer.",
      detail: "Close the window instead to keep working in the background.",
    });
    return response === 1;
  },
  dispose: async () => {
    await executions.dispose();
    await disposeOwnedProcesses();
    await runtime.dispose();
    tray?.destroy();
  },
  quit: () => app.quit(),
  reportError: (cause) => {
    console.error("[desktop] shutdown failed", cause);
    dialog.showErrorBox(
      "Could not stop desktop work",
      "Owned process cleanup failed. Check the desktop logs before quitting again.",
    );
  },
});

const runtime = ManagedRuntime.make(
  Layer.mergeAll(GrantStore.layerAt(grantsFile(app.getPath("userData"))), Sandbox.layer),
);

const desktopShell: Shell = {
  executionSession: () => ({ id: executions.id }),
  cancelCall: (callId) => executions.cancelCall(callId),
  setWorkState: (state) => {
    workState = state;
    const status =
      state.needsApproval > 0
        ? `${state.needsApproval} waiting for approval`
        : state.active > 0
          ? `${state.active} active`
          : "No active work";
    tray?.setToolTip(`Chat: ${status}`);
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
  // Executions and owned processes belong to the server that started them.
  // The runtime (grants, sandbox) is per machine and stays up.
  disposeWork: async () => {
    await executions.dispose();
    await disposeOwnedProcesses();
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
    mainWindow = openMainWindow(origin);
  },
  closeMain: () => {
    const window = mainWindow;
    mainWindow = null;
    window?.destroy();
  },
});

const openMainWindow = (origin: string) => {
  const window = new BrowserWindow({
    ...chromeOptions(platform, nativeTheme.shouldUseDarkColors),
    width: 1280,
    height: 860,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      preload: join(here, "preload.cjs"),
      // Known before the window exists, so the page hides the switch instead
      // of offering one that would only be refused.
      additionalArguments: devOrigin === null ? [] : [FIXED_SERVER_ARGUMENT],
    },
  });

  mainWindow = window;
  windowChrome.set(window, attachChrome(window, nativeTheme, platform));
  const recovery = attachLoadRecovery(window, origin, recoveryFile, (cause) =>
    console.error("[desktop] recovery page failed", cause),
  );
  windowRecovery.set(window, recovery);

  // Navigation is pinned to the configured origin. Anything else opens in the
  // real browser, where it has no bridge, rather than inside a window that does.
  window.webContents.on("will-navigate", (event, url) => {
    if (toOrigin(url) !== origin) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  window.on("close", (event) => lifecycle.close(event));
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
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

/** A sign-in ticket from the browser reaches the page only once it is loaded. */
const deliverTicket = (ticket: string) => {
  restoreWindow();
  const contents = mainWindow?.webContents;
  if (!contents) {
    pendingTicket = ticket;
    return;
  }
  if (contents.isLoadingMainFrame())
    contents.once("did-finish-load", () => contents.send(SIGN_IN_TICKET, ticket));
  else contents.send(SIGN_IN_TICKET, ticket);
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
  if (process.defaultApp && process.argv[1])
    app.setAsDefaultProtocolClient(SIGN_IN_SCHEME, process.execPath, [resolve(process.argv[1])]);
  else app.setAsDefaultProtocolClient(SIGN_IN_SCHEME);
}

void app.whenReady().then(async () => {
  if (!primaryInstance) return;
  const handlers = await runtime.runPromise(makeHandlers(desktopShell));
  respond = makeDesktopResponder(handlers);
  // The pinned dev server is decided from the environment, before start() runs.
  const pinned = Boolean(process.env.CHAT_DESKTOP_SERVER);
  const actions = [
    { label: "Show Chat", click: restoreWindow },
    ...(pinned
      ? []
      : [{ label: "Connect to a different server…", click: () => void chooseServer() }]),
    { label: "Quit Chat", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
  ];
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: "Chat", submenu: actions },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
  app.dock?.setMenu(Menu.buildFromTemplate(actions));
  // A small monochrome speech bubble works as a template icon and in Windows' tray.
  const pixels = Buffer.alloc(18 * 18 * 4);
  for (let y = 3; y < 16; y += 1) {
    for (let x = 2; x < 16; x += 1) {
      if (
        (y < 13 && (x === 2 || x === 15 || y === 3 || y === 12)) ||
        (x === 5 && y >= 12) ||
        (y === 14 && x === 6)
      )
        pixels[(y * 18 + x) * 4 + 3] = 255;
    }
  }
  const icon = nativeImage.createFromBitmap(pixels, { width: 18, height: 18 });
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Chat");
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
  ipcMain.handle(CHROME_SET_THEME, (event, theme: unknown) => {
    if (!isRemoteSender(event) || !mainWindow) throw new Error("Not allowed from this page.");
    windowChrome.get(mainWindow)?.setTheme(theme);
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
  const isConnectSender = (event: IpcMainInvokeEvent) =>
    isPageSender(event, connectWindow?.webContents, (url) => url === connectUrl);
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
    return executions.request(tag, payload);
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
  if (pendingTicket !== null) {
    const ticket = pendingTicket;
    pendingTicket = null;
    deliverTicket(ticket);
  }

  app.on("activate", restoreWindow);
});

// Hidden windows retain their renderer and work on every supported platform.
app.on("window-all-closed", () => {});
app.on("before-quit", (event) => {
  void lifecycle.beforeQuit(event);
});
