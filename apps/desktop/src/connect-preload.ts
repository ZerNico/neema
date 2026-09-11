import { contextBridge, ipcRenderer } from "electron";

/** The connect screen may do exactly one thing: propose a server address. */
contextBridge.exposeInMainWorld("__chatConnect", {
  connect: (url: string) => ipcRenderer.invoke("chat-desktop:connect", url),
});
