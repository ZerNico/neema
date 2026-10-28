import { contextBridge, ipcRenderer } from "electron";
import {
  APP_VIEW_ACTION,
  APP_VIEW_STATE,
  type AppViewAction,
  type AppViewState,
} from "./app-use/view-channels.ts";

// The floating window's page draws state and asks for its few actions; it has no other authority.
contextBridge.exposeInMainWorld("__appView", {
  onState: (listener: (state: AppViewState) => void) =>
    ipcRenderer.on(APP_VIEW_STATE, (_event, state: AppViewState) => listener(state)),
  act: (action: AppViewAction, chat: string) => ipcRenderer.send(APP_VIEW_ACTION, action, chat),
});
