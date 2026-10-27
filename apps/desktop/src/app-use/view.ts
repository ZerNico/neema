import { APP_USE_UPDATE, type AppUsePlacement, type AppUseUpdate } from "@chat/desktop-rpc";
import { BrowserWindow, ipcMain, screen } from "electron";
import { join } from "node:path";
import { m } from "../paraglide/messages.js";
import type { AppWatch, SharedAppDriver } from "./host.ts";
import { APP_VIEW_ACTION, APP_VIEW_STATE, type AppViewState } from "./view-channels.ts";
import { floats, parseChatKey } from "./view-state.ts";

/** Pictures a second while a chat uses apps: enough to follow along, cheap for the driver. */
const FRAME_MS = 250;
/** How long a chat counts as using apps after its last call, as the model thinks between calls. */
const LINGER_MS = 20_000;
const FLOATING_WIDTH = 320;
const HEADER = 40;

interface ChatView {
  readonly scope: string;
  readonly conversationId: string;
  spell: number;
  app: string;
  call: AppUseUpdate["call"];
  running: number;
  live: boolean;
  paused: boolean;
  placement: AppUsePlacement;
  /** The floating window was closed for this spell. */
  dismissed: boolean;
  frame: AppUseUpdate["frame"];
  click: AppUseUpdate["click"];
  /** The window's size in points, from the last picture, to place a click. */
  size: { width: number; height: number } | null;
  linger?: ReturnType<typeof setTimeout>;
}

/** The main window's page, where a chat's panel tab shows its view. */
export interface AppViewPage {
  readonly origin: string;
  readonly window: BrowserWindow;
}

/**
 * The person's live view of app use (docs/internals/app-use.md). Each chat's view lives on its
 * panel tab in the chat; the person can move it to a floating window above every app, and it
 * floats by itself while neema's window is minimized or hidden. The driver's window is
 * pictured a few times a second while a chat uses apps, and pausing refuses the chat's next
 * calls until resumed.
 */
export class AppView implements AppWatch {
  private readonly chats = new Map<string, ChatView>();
  /** The chat whose calls hold the driver, and so whose window `peek` pictures. */
  private active: string | null = null;
  private floating: BrowserWindow | null = null;
  /** The chat the floating window shows. */
  private floated: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ticking = false;

  constructor(
    private readonly options: {
      readonly driver: SharedAppDriver;
      readonly page: () => AppViewPage | null;
      /** Brings neema's window forward on a chat, for the floating window's way back. */
      readonly showChat: (conversationId: string) => void;
      readonly locale: () => Promise<"en" | "de">;
      readonly preload: string;
      readonly html: string;
    },
  ) {
    ipcMain.on(APP_VIEW_ACTION, (event, action: unknown) => {
      if (!this.floating || event.sender !== this.floating.webContents || !this.floated) return;
      const view = this.chats.get(this.floated);
      if (!view) return;
      if (action === "pause" || action === "resume") view.paused = action === "pause";
      if (action === "dock") {
        view.placement = "panel";
        this.options.showChat(view.conversationId);
      }
      if (action === "close") {
        view.placement = "panel";
        view.dismissed = true;
      }
      this.changed(view);
    });
  }

  started(
    chat: string,
    call: { name: string; args: Readonly<Record<string, unknown>>; app: string },
  ) {
    const view = this.chat(chat);
    if (!view) return;
    clearTimeout(view.linger);
    if (!view.live) {
      view.spell++;
      view.dismissed = false;
    }
    view.live = true;
    view.running++;
    view.call = { name: call.name, args: call.args };
    if (call.app) view.app = shortName(call.app);
    // Another chat's window until the first picture of this one.
    if (this.active !== chat) view.size = null;
    this.active = chat;
    this.changed(view);
    this.tick();
  }

  named(chat: string, app: string) {
    const view = this.chats.get(chat);
    if (!view || view.app === app) return;
    view.app = app;
    this.changed(view);
  }

  clicked(chat: string, at: { x: number; y: number }) {
    const view = this.chats.get(chat);
    if (!view?.size) return;
    view.click = { x: at.x / view.size.width, y: at.y / view.size.height, at: Date.now() };
    this.changed(view);
  }

  finished(chat: string) {
    const view = this.chats.get(chat);
    if (!view) return;
    view.running = Math.max(0, view.running - 1);
    if (view.running > 0) return;
    view.call = null;
    this.changed(view);
    clearTimeout(view.linger);
    view.linger = setTimeout(() => {
      view.live = false;
      this.changed(view);
    }, LINGER_MS);
  }

  paused(chat: string) {
    return this.chats.get(chat)?.paused ?? false;
  }

  forget(chat: string) {
    const view = this.chats.get(chat);
    if (!view) return;
    clearTimeout(view.linger);
    this.chats.delete(chat);
    if (this.active === chat) this.active = null;
    this.placeFloating();
  }

  /** A chat's view as it is now, for its server's page, which only asks about its own chats. */
  state(origin: string, conversationId: string): AppUseUpdate | null {
    const view = this.chats.get(key(origin, conversationId));
    return view ? update(view) : null;
  }

  pause(origin: string, conversationId: string, paused: boolean) {
    const view = this.chat(key(origin, conversationId));
    if (!view) return;
    view.paused = paused;
    this.changed(view);
  }

  place(origin: string, conversationId: string, placement: AppUsePlacement) {
    const view = this.chats.get(key(origin, conversationId));
    if (!view) return;
    view.placement = placement;
    if (placement === "floating") view.dismissed = false;
    this.changed(view);
  }

  /** neema's window was minimized, hidden or brought back: the floating window may follow. */
  windowChanged() {
    this.placeFloating();
  }

  close() {
    clearTimeout(this.timer);
    for (const view of this.chats.values()) clearTimeout(view.linger);
    ipcMain.removeAllListeners(APP_VIEW_ACTION);
    this.floating?.destroy();
    this.floating = null;
  }

  private chat(chat: string): ChatView | null {
    const known = this.chats.get(chat);
    if (known) return known;
    const parsed = parseChatKey(chat);
    if (!parsed) return null;
    const view: ChatView = {
      ...parsed,
      spell: 0,
      app: "",
      call: null,
      running: 0,
      live: false,
      paused: false,
      placement: "panel",
      dismissed: false,
      frame: null,
      click: null,
      size: null,
    };
    this.chats.set(chat, view);
    return view;
  }

  /** Tells the chat's page and the floating window, which may come, go or change chats. */
  private changed(view: ChatView) {
    const page = this.options.page();
    if (page && page.origin === view.scope && !page.window.isDestroyed())
      page.window.webContents.send(APP_USE_UPDATE, update(view));
    this.placeFloating();
    if (this.floated === key(view.scope, view.conversationId)) void this.drawFloating(view);
  }

  /** Pictures the active chat's window while it uses apps, one picture after another. */
  private tick() {
    if (this.ticking) return;
    const view = this.active ? this.chats.get(this.active) : undefined;
    if (!view?.live) return;
    this.ticking = true;
    void this.options.driver
      .call("peek", {})
      .then((peek) => {
        view.size = peek.window;
        // A window that sits still between actions sends nothing.
        if (view.frame?.data === peek.data) return;
        view.frame = { data: peek.data, width: peek.width, height: peek.height };
        this.changed(view);
      })
      // Nothing looked at yet, or the window is gone for a moment: the last picture stays.
      .catch(() => {})
      .finally(() => {
        this.ticking = false;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.tick(), FRAME_MS);
      });
  }

  private placeFloating() {
    const page = this.options.page();
    const mainVisible =
      !!page && !page.window.isDestroyed() && page.window.isVisible() && !page.window.isMinimized();
    // The active chat first, as it is the one moving; else one the person floated.
    const order = [
      ...(this.active ? [this.active] : []),
      ...[...this.chats.keys()].filter((chat) => chat !== this.active),
    ];
    const shown = order.find((chat) => {
      const view = this.chats.get(chat)!;
      return floats({
        placement: view.placement,
        dismissed: view.dismissed,
        live: view.live,
        hasFrame: view.frame !== null,
        mainVisible,
      });
    });
    if (!shown) {
      this.floated = null;
      this.floating?.hide();
      return;
    }
    const switched = this.floated !== shown;
    this.floated = shown;
    const window = this.floating ?? this.createFloating();
    if (switched) void this.drawFloating(this.chats.get(shown)!);
    // Never activates neema: the person keeps their front app, as app use itself does.
    if (!window.isVisible()) window.showInactive();
  }

  private createFloating() {
    const area = screen.getPrimaryDisplay().workArea;
    const height = 260;
    const window = new BrowserWindow({
      width: FLOATING_WIDTH,
      height,
      x: area.x + area.width - FLOATING_WIDTH - 20,
      y: area.y + area.height - height - 20,
      frame: false,
      resizable: false,
      focusable: false,
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
      const view = this.floated ? this.chats.get(this.floated) : undefined;
      if (view) void this.drawFloating(view);
    });
    window.on("closed", () => {
      if (this.floating === window) this.floating = null;
    });
    void window.loadFile(this.options.html);
    this.floating = window;
    return window;
  }

  private async drawFloating(view: ChatView) {
    const locale = await this.options.locale();
    const window = this.floating;
    if (!window || window.isDestroyed()) return;
    const app = view.app || "…";
    const state: AppViewState = {
      title: m.app_view_title({ app }, { locale }),
      label: view.paused
        ? m.app_view_paused({}, { locale })
        : view.call
          ? activity(view.call.name, view.call.args, app, locale)
          : view.live
            ? m.app_view_title({ app }, { locale })
            : m.app_view_done({}, { locale }),
      live: view.live,
      paused: view.paused,
      words: {
        pause: m.app_view_pause({}, { locale }),
        resume: m.app_view_resume({}, { locale }),
        paused: m.app_view_paused({}, { locale }),
        dock: m.app_view_dock({}, { locale }),
        close: m.app_view_close({}, { locale }),
        waiting: m.app_view_waiting({}, { locale }),
      },
      frame: view.frame,
      click: view.click,
    };
    if (view.frame) this.fit(window, view.frame.width, view.frame.height);
    window.webContents.send(APP_VIEW_STATE, state);
  }

  /** The window takes the picture's shape below its header, growing up from its corner. */
  private fit(window: BrowserWindow, width: number, height: number) {
    const target = Math.round(HEADER + (FLOATING_WIDTH * height) / width);
    const clamped = Math.min(Math.max(target, 140), 560);
    const bounds = window.getBounds();
    if (Math.abs(bounds.height - clamped) < 2) return;
    window.setBounds({ ...bounds, y: bounds.y + bounds.height - clamped, height: clamped });
  }
}

const key = (origin: string, conversationId: string) => `${origin}\u0000${conversationId}`;

const update = (view: ChatView): AppUseUpdate => ({
  conversationId: view.conversationId,
  spell: view.spell,
  app: view.app,
  call: view.call,
  live: view.live,
  paused: view.paused,
  placement: view.placement,
  frame: view.frame,
  click: view.click,
});

/** The model may name an app by bundle id; its last part is the app ("com.apple.calculator"). */
const shortName = (app: string) => (/^[\w-]+(\.[\w-]+)+$/.test(app) ? app.split(".").at(-1)! : app);

/** What a call does, in the words the chat's rows use. */
const activity = (
  name: string,
  args: Readonly<Record<string, unknown>>,
  app: string,
  locale: "en" | "de",
) => {
  const options = { locale };
  switch (name) {
    case "app_list":
      return m.app_running_list({}, options);
    case "app_open":
      return m.app_running_open({ app }, options);
    case "app_click":
      return m.app_running_click({ app }, options);
    case "app_type":
      return m.app_running_type({ app }, options);
    case "app_key":
      return m.app_running_key(
        { key: typeof args.keys === "string" ? args.keys : "", app },
        options,
      );
    case "app_scroll":
      return m.app_running_scroll({ app }, options);
    case "app_drag":
      return m.app_running_drag({ app }, options);
    case "app_zoom":
      return m.app_running_zoom({ app }, options);
    default:
      return m.app_running_look({ app }, options);
  }
};

export const appViewFiles = (here: string) => ({
  preload: join(here, "app-view-preload.cjs"),
  html: join(here, "..", "static", "app-view.html"),
});
