import { contextBridge, ipcRenderer } from "electron";
import { makeLocalChromeBridge } from "./chrome-preload.ts";
import { CONNECT, CONNECT_CURRENT } from "./chrome.ts";

// Local presentation is read-only; connecting is this page's only authority.
contextBridge.exposeInMainWorld("__chatConnect", {
  chrome: makeLocalChromeBridge(ipcRenderer, process.platform),
  current: () => ipcRenderer.invoke(CONNECT_CURRENT),
  connect: (url: string) => ipcRenderer.invoke(CONNECT, url),
});
