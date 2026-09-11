import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { join } from "node:path";
import { Layer, ManagedRuntime } from "effect";
import { makeDesktopResponder } from "@chat/desktop-rpc";
import { configFile, readConfig, toOrigin, writeConfig } from "./config.ts";
import { grantsFile, GrantStore } from "./grants.ts";
import { makeHandlers, type Shell } from "./handlers.ts";
import { Sandbox } from "./sandbox.ts";

// Bundled to CJS, because an Electron preload must be CJS while `sandbox: true`.
// `import.meta.url` is empty under that format; `__dirname` is the real thing.
const here = __dirname;
const REQUEST_CHANNEL = "chat-desktop:request";
const CONNECT_CHANNEL = "chat-desktop:connect";

/**
 * The shell: a window pointed at one server, plus a bridge only that server's
 * pages can reach.
 *
 * The site is remote code running with a door into this machine, so the origin
 * it was pointed at is checked on every single call rather than once at load.
 * A page that navigates elsewhere, or a frame embedded inside it, gets nothing.
 */

let serverOrigin: string | null = null;
let mainWindow: BrowserWindow | null = null;

const runtime = ManagedRuntime.make(
  Layer.mergeAll(GrantStore.layerAt(grantsFile(app.getPath("userData"))), Sandbox.layer),
);

const desktopShell: Shell = {
  pickDirectory: async () => {
    const parent = mainWindow;
    const result = await (parent
      ? dialog.showOpenDialog(parent, { properties: ["openDirectory"] })
      : dialog.showOpenDialog({ properties: ["openDirectory"] }));
    return result.canceled ? null : (result.filePaths[0] ?? null);
  },
  reveal: async (absolute) => {
    shell.showItemInFolder(absolute);
  },
};

const openConnectWindow = () => {
  const window = new BrowserWindow({
    width: 520,
    height: 360,
    resizable: false,
    title: "Connect",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(here, "connect-preload.js"),
    },
  });
  void window.loadFile(join(here, "..", "static", "connect.html"));
  return window;
};

const openMainWindow = (origin: string) => {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(here, "preload.js"),
    },
  });

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

  void window.loadURL(origin);
  return window;
};

const start = async () => {
  const file = configFile(app.getPath("userData"));
  const config = await readConfig(file);

  if (config === null) {
    const connect = openConnectWindow();
    ipcMain.handle(CONNECT_CHANNEL, async (_event, candidate: unknown) => {
      const origin = typeof candidate === "string" ? toOrigin(candidate) : null;
      if (origin === null)
        return { ok: false, message: "That does not look like a server address." };
      await writeConfig(file, { serverUrl: origin });
      serverOrigin = origin;
      mainWindow = openMainWindow(origin);
      connect.close();
      return { ok: true };
    });
    return;
  }

  serverOrigin = config.serverUrl;
  mainWindow = openMainWindow(config.serverUrl);
};

void app.whenReady().then(async () => {
  const handlers = await runtime.runPromise(makeHandlers(desktopShell));
  const respond = makeDesktopResponder(handlers);

  ipcMain.handle(REQUEST_CHANNEL, async (event, message: unknown) => {
    // Re-checked per call, not once at load: a window that has navigated, or a
    // frame inside it, must not inherit the door the configured origin has.
    const sender = event.senderFrame?.url ?? "";
    if (serverOrigin === null || toOrigin(sender) !== serverOrigin) {
      return {
        ok: false,
        error: { _tag: "DesktopError", reason: "failed", message: "Not allowed from this page." },
      };
    }
    const { tag, payload } = (message ?? {}) as { tag?: unknown; payload?: unknown };
    if (typeof tag !== "string") {
      return {
        ok: false,
        error: { _tag: "DesktopError", reason: "failed", message: "Malformed request." },
      };
    }
    return runtime.runPromise(respond(tag, payload));
  });

  await start();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverOrigin !== null) {
      mainWindow = openMainWindow(serverOrigin);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Tears down the sandbox proxies and Windows ACLs; srt also hooks process exit,
// but leaving it to that would race the app's own shutdown.
app.on("before-quit", () => {
  void runtime.dispose();
});
