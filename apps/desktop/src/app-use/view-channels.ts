// Shared by the floating window's main side and its preload, which may load nothing else.

export const APP_VIEW_STATE = "chat-desktop:app-view-state";
export const APP_VIEW_ACTION = "chat-desktop:app-view-action";

/** What the floating window may ask for: its chat's pause, back into the chat, or away. */
export type AppViewAction = "pause" | "resume" | "dock" | "close";

/** What the floating window draws; the words come already in the person's language. */
export interface AppViewState {
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
  readonly frame: { readonly data: string; readonly width: number; readonly height: number } | null;
  /** The last click, as a fraction of the window, so the page needs no window size. */
  readonly click: { readonly x: number; readonly y: number; readonly at: number } | null;
}
