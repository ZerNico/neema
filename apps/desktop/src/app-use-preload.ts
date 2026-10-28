import type { IpcRenderer } from "electron";
import {
  APP_USE_PAUSE,
  APP_USE_STATE,
  APP_USE_UPDATE,
  type AppUseUpdate,
  type DesktopAppUse,
} from "@chat/desktop-rpc";

/** The page's view of app use: it hears updates and may only pause them. */
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
  pause: (conversationId, paused) => ipc.invoke(APP_USE_PAUSE, { conversationId, paused }),
});
