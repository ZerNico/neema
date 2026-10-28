import { BrowserWindow, ipcMain, screen } from "electron";
import { join } from "node:path";
import { m } from "../paraglide/messages.js";
import { parseChatKey } from "./chat-key.ts";
import type { LiveView } from "./live.ts";
import { APP_VIEW_ACTION, APP_VIEW_STATE, type AppViewState } from "./view-channels.ts";

const WIDTH = 320;
const HEADER = 40;

/** The main window's page, where a chat's panel tab shows its view. */
export interface FloatingPage {
  readonly origin: string;
  readonly window: BrowserWindow;
}

/**
 * The floating window a chat's live view moves to (docs/internals/app-use.md): above every app,
 * never taking focus, so the person keeps their front app as app use itself does. It follows
 * `LiveView` as the page does and shows the connected server's chats only.
 */
export class FloatingView {
  private window: BrowserWindow | null = null;
  /** The chat it shows. */
  private shown: string | null = null;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly live: LiveView,
    private readonly options: {
      readonly page: () => FloatingPage | null;
      /** Brings neema's window forward on a chat, by key, for the floating window's way back. */
      readonly showChat: (chat: string) => void;
      readonly preload: string;
      readonly html: string;
    },
  ) {
    this.unsubscribe = live.subscribe((chat) => this.place(chat));
    ipcMain.on(APP_VIEW_ACTION, (event, action: unknown, chat: unknown) => {
      const shown = this.shown;
      if (!this.window || event.sender !== this.window.webContents || !shown) return;
      // Pressed for the chat the person saw, which may have given way to another since.
      if (chat !== shown) return;
      if (action === "pause" || action === "resume") live.pause(shown, action === "pause");
      if (action === "dock") {
        live.place(shown, "panel");
        this.options.showChat(shown);
      }
      if (action === "close") live.dismiss(shown);
    });
  }

  /**
   * Shows, moves or hides the window after `changed`, a chat that changed, or after neema's
   * window was minimized, hidden or brought back.
   */
  place(changed?: string) {
    const page = this.options.page();
    const visible =
      !!page && !page.window.isDestroyed() && page.window.isVisible() && !page.window.isMinimized();
    const shown = page ? this.live.floating(page.origin, visible, this.shown) : null;
    if (!shown) {
      this.shown = null;
      this.window?.hide();
      return;
    }
    const window = this.window ?? this.create();
    if (shown !== this.shown || shown === changed) {
      this.shown = shown;
      this.draw(shown);
    }
    if (!window.isVisible()) window.showInactive();
  }

  close() {
    this.unsubscribe();
    ipcMain.removeAllListeners(APP_VIEW_ACTION);
    this.window?.destroy();
    this.window = null;
  }

  private create() {
    const area = screen.getPrimaryDisplay().workArea;
    const height = 260;
    const window = new BrowserWindow({
      width: WIDTH,
      height,
      x: area.x + area.width - WIDTH - 20,
      y: area.y + area.height - height - 20,
      frame: false,
      resizable: false,
      focusable: false,
      // Its buttons answer the first click, which would otherwise only reach the window.
      acceptFirstMouse: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      fullscreenable: false,
      hasShadow: true,
      roundedCorners: true,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        preload: this.options.preload,
      },
    });
    window.setAlwaysOnTop(true, "floating");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("did-finish-load", () => {
      if (this.shown) this.draw(this.shown);
    });
    window.on("closed", () => {
      if (this.window === window) this.window = null;
    });
    void window.loadFile(this.options.html);
    this.window = window;
    return window;
  }

  private draw(chat: string) {
    const window = this.window;
    const update = this.live.update(chat);
    const parsed = parseChatKey(chat);
    if (!window || window.isDestroyed() || !update || !parsed) return;
    const options = { locale: this.live.locale(parsed.scope) };
    const app = update.app || m.app_view_tab({}, options);
    const state: AppViewState = {
      chat,
      lang: options.locale,
      title: m.app_view_title({ app }, options),
      label: update.label,
      live: update.live,
      paused: update.paused,
      words: {
        pause: m.app_view_pause({}, options),
        resume: m.app_view_resume({}, options),
        paused: m.app_view_paused({}, options),
        dock: m.app_view_dock({}, options),
        close: m.app_view_close({}, options),
        waiting: m.app_view_waiting({}, options),
      },
      frame: update.frame,
      click: update.click,
    };
    if (update.frame) this.fit(window, update.frame.width, update.frame.height);
    window.webContents.send(APP_VIEW_STATE, state);
  }

  /** The window takes the picture's shape below its header, growing up from its corner. */
  private fit(window: BrowserWindow, width: number, height: number) {
    const target = Math.round(HEADER + (WIDTH * height) / width);
    const clamped = Math.min(Math.max(target, 140), 560);
    const bounds = window.getBounds();
    if (Math.abs(bounds.height - clamped) < 2) return;
    window.setBounds({ ...bounds, y: bounds.y + bounds.height - clamped, height: clamped });
  }
}

export const floatingFiles = (here: string) => ({
  preload: join(here, "app-view-preload.cjs"),
  html: join(here, "..", "static", "app-view.html"),
});
