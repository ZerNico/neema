import type { AppUseUpdate } from "@chat/desktop-rpc";
import { m } from "../paraglide/messages.js";
import { parseChatKey } from "./chat-key.ts";
import type { AppCall, AppWatch } from "./host.ts";

/** Pictures a second while a chat uses apps: enough to follow along, cheap for the driver. */
const FRAME_MS = 250;
/** How long a chat counts as using apps after its last call, as the model thinks between calls. */
const LINGER_MS = 20_000;

type Locale = "en" | "de";

/** All a live view asks of the shared driver: whose look it holds, and a picture of it. */
export interface LiveDriver {
  readonly holder: string | null;
  /** A driver is running; a picture is never worth starting one. */
  readonly running: boolean;
  call(
    method: "peek",
    params: Record<string, never>,
  ): Promise<{ readonly data: string; readonly width: number; readonly height: number }>;
}

interface Chat {
  readonly key: string;
  readonly scope: string;
  readonly conversationId: string;
  spell: number;
  app: string;
  /** The call running now; a chat's calls run one at a time, through the shared driver. */
  call: { readonly name: string; readonly args: AppCall["args"] } | null;
  live: boolean;
  paused: boolean;
  yielding: boolean;
  frame: AppUseUpdate["frame"];
  click: AppUseUpdate["click"];
  linger?: ReturnType<typeof setTimeout>;
}

/**
 * Each chat's live view of app use (docs/internals/app-use.md), told to the chat's page. It
 * pictures the driver's window a few times a second
 * while chats use apps, and only for the chat whose look the driver holds, since the driver
 * pictures whatever was looked at last, whoever asked. It knows nothing of windows.
 */
export class LiveView implements AppWatch {
  /**
   * Every chat that used an app since neema started, kept until it is deleted: a few strings and
   * its last picture each, and its Pause, which must outlast the spell it was pressed in.
   */
  private readonly chats = new Map<string, Chat>();
  /**
   * The chats their server's page asked about since it loaded, and so may be told of: a page
   * asks about each chat it shows, and shows only its person's own. A page that loads afresh,
   * perhaps for another person, starts with none.
   */
  private readonly asked = new Set<string>();
  private readonly listeners = new Set<(chat: string) => void>();
  /** Each server's language, read when its chats act, so a label is written without waiting. */
  private readonly locales = new Map<string, Locale>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ticking = false;
  private closed = false;

  constructor(
    private readonly options: {
      readonly driver: LiveDriver;
      readonly locale: (origin: string) => Promise<Locale>;
    },
  ) {}

  /** Hears every chat that changed, by key. */
  subscribe(listener: (chat: string) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  begin(key: string, call: { name: string; args: AppCall["args"]; app: string }) {
    const chat = this.chat(key);
    if (!chat) return true;
    // A new spell; and every call refused while paused is one too, so its view comes back with
    // Resume on it even if the person just closed it.
    if (!chat.live || chat.paused) {
      chat.spell++;
      chat.click = null;
    }
    chat.live = true;
    if (chat.paused) {
      // Refused: the model was told to send the person to Resume.
      this.linger(chat);
      this.notify(chat.key);
      return false;
    }
    clearTimeout(chat.linger);
    chat.yielding = false;
    chat.call = { name: call.name, args: call.args };
    if (call.app) chat.app = shortName(call.app);
    this.readLocale(chat.scope);
    this.notify(chat.key);
    this.tick();
    return true;
  }

  named(key: string, app: string) {
    const chat = this.chats.get(key);
    if (!chat || chat.app === app) return;
    chat.app = app;
    // A ring from the app before means nothing on this one.
    chat.click = null;
    this.notify(chat.key);
  }

  clicked(key: string, at: { x: number; y: number }) {
    const chat = this.chats.get(key);
    if (!chat) return;
    chat.click = { ...at, at: Date.now() };
    this.notify(chat.key);
  }

  yielded(key: string) {
    const chat = this.chats.get(key);
    if (!chat) return;
    chat.yielding = true;
    this.notify(chat.key);
  }

  finished(key: string) {
    const chat = this.chats.get(key);
    if (!chat) return;
    chat.call = null;
    this.notify(chat.key);
    this.linger(chat);
  }

  /** The chat stays live a while after its last call, as the model thinks between calls. */
  private linger(chat: Chat) {
    clearTimeout(chat.linger);
    chat.linger = setTimeout(() => {
      chat.live = false;
      // It waited for the person within the spell; the spell is over.
      chat.yielding = false;
      this.notify(chat.key);
    }, LINGER_MS);
  }

  forget(key: string) {
    const chat = this.chats.get(key);
    if (!chat) return;
    clearTimeout(chat.linger);
    // Its page hears it is over before it is forgotten, so a tab still open stops showing it live.
    chat.live = false;
    chat.call = null;
    this.notify(key);
    this.chats.delete(key);
    this.asked.delete(key);
  }

  /** A chat's view as its page draws it; null before it used an app. */
  update(key: string): AppUseUpdate | null {
    const chat = this.chats.get(key);
    if (!chat) return null;
    return {
      conversationId: chat.conversationId,
      spell: chat.spell,
      app: chat.app,
      label: this.label(chat),
      busy: chat.call !== null && !chat.yielding,
      live: chat.live,
      paused: chat.paused,
      frame: chat.frame,
      click: chat.click,
    };
  }

  /** A chat's view for its server's page, which from now on is told of it; see `asked`. */
  view(key: string): AppUseUpdate | null {
    this.asked.add(key);
    return this.update(key);
  }

  /** The chat's page asked about it since it loaded, so the chat is its to see and steer. */
  told(key: string) {
    return this.asked.has(key);
  }

  /**
   * A server's page loaded afresh, perhaps for another person. It is told of no chat until it
   * asks, and what its chats showed ends: their spells and pictures. Pause stays, as the
   * person's word does; the language is read again.
   */
  pageLoaded(origin: string) {
    for (const key of this.asked) if (parseChatKey(key)?.scope === origin) this.asked.delete(key);
    for (const chat of this.chats.values()) {
      if (chat.scope !== origin) continue;
      clearTimeout(chat.linger);
      // A call still running keeps its spell, with its pictures and Pause button.
      chat.live = chat.call !== null;
      chat.yielding = false;
      chat.frame = null;
      chat.click = null;
      this.notify(chat.key);
    }
    this.readLocale(origin);
  }

  /** Paused, the chat's next calls are refused until it is resumed; see `begin`. */
  pause(key: string, paused: boolean) {
    const chat = this.chat(key);
    if (!chat || chat.paused === paused) return;
    chat.paused = paused;
    this.notify(chat.key);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    for (const chat of this.chats.values()) clearTimeout(chat.linger);
    this.listeners.clear();
  }

  private locale(origin: string): Locale {
    return this.locales.get(origin) ?? "en";
  }

  private chat(key: string): Chat | null {
    const known = this.chats.get(key);
    if (known) return known;
    const parsed = parseChatKey(key);
    if (!parsed) return null;
    const chat: Chat = {
      key,
      ...parsed,
      spell: 0,
      app: "",
      call: null,
      live: false,
      paused: false,
      yielding: false,
      frame: null,
      click: null,
    };
    this.chats.set(key, chat);
    return chat;
  }

  /** Reads a server's language again; its chats are told when it changed. */
  private readLocale(origin: string) {
    void this.options.locale(origin).then(
      (locale) => {
        if (this.locales.get(origin) === locale) return;
        this.locales.set(origin, locale);
        for (const chat of this.chats.values()) if (chat.scope === origin) this.notify(chat.key);
      },
      () => {},
    );
  }

  private notify(key: string) {
    for (const listener of this.listeners) listener(key);
  }

  /**
   * One picture after another while any chat uses apps. A picture belongs to the chat holding
   * the driver's look when it was taken, and is dropped if the look changed hands meanwhile.
   * Never starts a driver: one that is gone is started by the next call.
   */
  private tick() {
    if (this.ticking || this.closed) return;
    if (![...this.chats.values()].some((chat) => chat.live)) return;
    this.ticking = true;
    const holder = this.options.driver.holder;
    const chat = holder ? this.chats.get(holder) : undefined;
    const taken =
      chat?.live && this.options.driver.running
        ? this.options.driver.call("peek", {}).then((peek) => {
            // A window that sits still between actions sends nothing.
            if (this.options.driver.holder !== holder || chat.frame?.data === peek.data) return;
            chat.frame = { data: peek.data, width: peek.width, height: peek.height };
            this.notify(chat.key);
          })
        : undefined;
    // Nothing looked at yet, or the window is gone for a moment: the last picture stays.
    void Promise.resolve(taken)
      .catch(() => {})
      .finally(() => {
        this.ticking = false;
        clearTimeout(this.timer);
        if (!this.closed) this.timer = setTimeout(() => this.tick(), FRAME_MS);
      });
  }

  /** What is happening, in the words the chat's rows use, in the chat's server's language. */
  private label(chat: Chat) {
    const options = { locale: this.locale(chat.scope) };
    const app = chat.app || m.app_view_tab({}, options);
    if (chat.paused) return m.app_view_paused({}, options);
    if (chat.yielding) return m.app_view_yielding({ app }, options);
    if (chat.call) return activity(chat.call, app, options);
    return chat.live ? m.app_view_title({ app }, options) : m.app_view_done({}, options);
  }
}

/** The model may name an app by bundle id; its last part is the app ("com.apple.calculator"). */
const shortName = (app: string) =>
  /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(app) ? app.split(".").at(-1)! : app;

const activity = (
  call: NonNullable<Chat["call"]>,
  app: string,
  options: { readonly locale: Locale },
) => {
  switch (call.name) {
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
        { key: typeof call.args.keys === "string" ? call.args.keys : "", app },
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
