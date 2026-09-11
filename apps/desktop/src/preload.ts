import { contextBridge, ipcRenderer } from "electron";

/**
 * The whole surface the site can see. Not `fs`, not `ipcRenderer`, not a
 * module registry: one function that forwards a tag and a payload and returns
 * whatever the main process decides to answer.
 *
 * This runs with `contextIsolation`, so the object below is copied across the
 * boundary rather than shared. The site cannot reach back through it, and
 * nothing here closes over anything privileged.
 *
 * The main process re-checks the sender's origin on every call. That check is
 * not repeated here on purpose: a preload runs inside the renderer, so anything
 * it decided could be worked around by the page it was protecting against.
 */

const REQUEST_CHANNEL = "chat-desktop:request";
const PROTOCOL_VERSION = 1;
const BRIDGE_KEY = "__chatDesktop";

contextBridge.exposeInMainWorld(BRIDGE_KEY, {
  protocolVersion: PROTOCOL_VERSION,
  request: (tag: unknown, payload: unknown) =>
    ipcRenderer.invoke(REQUEST_CHANNEL, { tag, payload }),
});
