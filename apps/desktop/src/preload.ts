import { contextBridge, ipcRenderer } from "electron";
import { BRIDGE_KEY, PROTOCOL_VERSION } from "@chat/desktop-rpc";
import { makeChromeBridge, makeLocalChromeBridge } from "./chrome-preload.ts";
import { canChangeServer, makeAuthBridge } from "./auth-preload.ts";
import { CHANGE_SERVER, RECOVERY_RETRY } from "./chrome.ts";

declare const location: { readonly protocol: string };

// The same window can recover locally, but that document has no Work surface.
// Main checks the exact bundled file, window and frame on every recovery call.
if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("__chatRecovery", {
    chrome: makeLocalChromeBridge(ipcRenderer, process.platform),
    retry: () => ipcRenderer.invoke(RECOVERY_RETRY),
    canChangeServer: canChangeServer(process.argv),
    changeServer: () => ipcRenderer.invoke(CHANGE_SERVER),
  });
} else {
  contextBridge.exposeInMainWorld(BRIDGE_KEY, {
    protocolVersion: PROTOCOL_VERSION,
    build: __BUILD_STAMP__,
    chrome: makeChromeBridge(ipcRenderer, process.platform),
    auth: makeAuthBridge(ipcRenderer, process.argv),
    request: (tag: unknown, payload: unknown) =>
      ipcRenderer.invoke("chat-desktop:request", { tag, payload }),
  });
}
