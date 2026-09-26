import { contextBridge, ipcRenderer, webUtils } from "electron";
import { BRIDGE_KEY, DROPPED_FILE_CHANNEL, PROTOCOL_VERSION } from "@chat/desktop-rpc";
import { makeChromeBridge, makeLocalChromeBridge } from "./chrome-preload.ts";
import { canChangeServer, makeAuthBridge } from "./auth-preload.ts";
import { makeNetworkBridge } from "./network-preload.ts";
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
    network: makeNetworkBridge(ipcRenderer),
    // The host path never crosses into the remote page. A synthetic File has
    // no path and returns null so pasted data can use the bounded base64 RPC.
    stageDroppedFile: (file: File, payload: unknown) => {
      const sourcePath = webUtils.getPathForFile(file);
      return sourcePath === ""
        ? Promise.resolve(null)
        : ipcRenderer.invoke(DROPPED_FILE_CHANNEL, { payload, sourcePath });
    },
    request: (tag: unknown, payload: unknown) =>
      ipcRenderer.invoke("chat-desktop:request", { tag, payload }),
  });
}
