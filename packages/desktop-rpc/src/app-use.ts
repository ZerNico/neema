import { Schema } from "effect";

/**
 * Optional live view of app use, independent of the bridge's protocol version: what the model
 * is doing in the person's apps, for the chat's panel tab and the floating window it can move to
 * (docs/internals/app-use.md).
 */
export const APP_USE_UPDATE = "chat-desktop:app-use-update" as const;
export const APP_USE_OPEN_CHAT = "chat-desktop:app-use-open-chat" as const;
export const APP_USE_STATE = "chat-desktop:app-use-state" as const;
export const APP_USE_PAUSE = "chat-desktop:app-use-pause" as const;
export const APP_USE_PLACE = "chat-desktop:app-use-place" as const;

/** Where a chat's live view is: its panel tab, or a floating window above every app. */
export const AppUsePlacement = Schema.Literals(["panel", "floating"]);
export type AppUsePlacement = typeof AppUsePlacement.Type;

const ConversationId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
/** The page's payloads, decoded by main before anything acts on them. */
export const AppUseChat = Schema.Struct({ conversationId: ConversationId });
export const AppUsePause = Schema.Struct({
  conversationId: ConversationId,
  paused: Schema.Boolean,
});
export const AppUsePlace = Schema.Struct({
  conversationId: ConversationId,
  placement: AppUsePlacement,
});

/** One chat's app use as the view draws it. */
export interface AppUseUpdate {
  readonly conversationId: string;
  /**
   * Counts the chat's spells of app use: a new one starts when a call comes after the view
   * went quiet, so the page opens its tab once per spell and not again after the person
   * closed it.
   */
  readonly spell: number;
  /** The app as macOS names it, or as the model asked for it until resolved. */
  readonly app: string;
  /** The call running now, for its label; null between calls. */
  readonly call: { readonly name: string; readonly args: Readonly<Record<string, unknown>> } | null;
  /** Calls are coming: one runs, or the last ended moments ago. */
  readonly live: boolean;
  readonly paused: boolean;
  readonly placement: AppUsePlacement;
  /** The window last looked at, as a small PNG; null before the first. */
  readonly frame: { readonly data: string; readonly width: number; readonly height: number } | null;
  /** The last click, as a fraction of the window, with when it happened. */
  readonly click: { readonly x: number; readonly y: number; readonly at: number } | null;
}

export interface DesktopAppUse {
  /** The chat's view as it is now; null when it has never used an app on this machine. */
  state(conversationId: string): Promise<AppUseUpdate | null>;
  onUpdate(listener: (update: AppUseUpdate) => void): () => void;
  /** The floating window asks to show a chat in the main window, on its panel tab. */
  onOpenChat(listener: (conversationId: string) => void): () => void;
  /** Paused, the chat's next app calls are refused until resumed. */
  pause(conversationId: string, paused: boolean): Promise<void>;
  place(conversationId: string, placement: AppUsePlacement): Promise<void>;
}

export function readDesktopAppUse(): DesktopAppUse | null {
  const channel = Reflect.get(globalThis, "__chatDesktop");
  if (typeof channel !== "object" || channel === null) return null;
  const appUse = Reflect.get(channel, "appUse");
  if (typeof appUse !== "object" || appUse === null) return null;
  if (
    typeof appUse.state !== "function" ||
    typeof appUse.onUpdate !== "function" ||
    typeof appUse.onOpenChat !== "function" ||
    typeof appUse.pause !== "function" ||
    typeof appUse.place !== "function"
  )
    return null;
  return appUse as DesktopAppUse;
}
