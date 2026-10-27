import type { IpcRenderer } from "electron";
import {
  APP_USE_OPEN_CHAT,
  APP_USE_PAUSE,
  APP_USE_PLACE,
  APP_USE_STATE,
  APP_USE_UPDATE,
  type AppUseUpdate,
  type DesktopAppUse,
} from "@chat/desktop-rpc";

/** The page's view of app use: it hears updates and may only pause and place them. */
export const makeAppUseBridge = (
  ipc: Pick<IpcRenderer, "invoke" | "on" | "removeListener">,
): DesktopAppUse => ({
  state: (conversationId) => ipc.invoke(APP_USE_STATE, { conversationId }),
  onUpdate: (listener) => {
    const receive = (_event: unknown, update: AppUseUpdate) => listener(update);
    ipc.on(APP_USE_UPDATE, receive);
    return () => {
      ipc.removeListener(APP_USE_UPDATE, receive);
    };
  },
  onOpenChat: (listener) => {
    const receive = (_event: unknown, conversationId: unknown) => {
      if (typeof conversationId === "string") listener(conversationId);
    };
    ipc.on(APP_USE_OPEN_CHAT, receive);
    return () => {
      ipc.removeListener(APP_USE_OPEN_CHAT, receive);
    };
  },
  pause: (conversationId, paused) => ipc.invoke(APP_USE_PAUSE, { conversationId, paused }),
  place: (conversationId, placement) => ipc.invoke(APP_USE_PLACE, { conversationId, placement }),
});
