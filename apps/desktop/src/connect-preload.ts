import { contextBridge, ipcRenderer } from "electron";
import { makeLocalChromeBridge } from "./chrome-preload.ts";

// Local presentation is read-only; connecting is this page's only authority.
contextBridge.exposeInMainWorld("__chatConnect", {
  chrome: makeLocalChromeBridge(ipcRenderer, process.platform),
  connect: (url: string) => ipcRenderer.invoke("chat-desktop:connect", url),
});
