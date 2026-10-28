// Shared by the floating window's main side and its preload, which may load nothing else.
import type { AppUseUpdate } from "@chat/desktop-rpc";

export const APP_VIEW_STATE = "chat-desktop:app-view-state";
export const APP_VIEW_ACTION = "chat-desktop:app-view-action";

/** What the floating window may ask for: its chat's pause, back into the chat, or away. */
export type AppViewAction = "pause" | "resume" | "dock" | "close";

/** What the floating window draws; the words come already in the chat's language. */
export interface AppViewState {
  /** The chat shown, which each action names back, so one meant for another is ignored. */
  readonly chat: string;
  readonly lang: string;
  readonly title: string;
  readonly label: string;
  readonly live: boolean;
  readonly paused: boolean;
  readonly words: {
    readonly pause: string;
    readonly resume: string;
    readonly paused: string;
    readonly dock: string;
    readonly close: string;
    readonly waiting: string;
  };
  readonly frame: AppUseUpdate["frame"];
  readonly click: AppUseUpdate["click"];
}
