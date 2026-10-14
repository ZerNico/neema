import type { IpcRenderer } from "electron";
import {
  NETWORK_LIST,
  NETWORK_REVOKE,
  PATHS_LIST,
  PATHS_REVOKE,
  LOCAL_GET,
  LOCAL_REVOKE,
  AGENT_GET,
  AGENT_CHOOSE,
  type DesktopNetwork,
} from "@chat/desktop-rpc";

export const makeNetworkBridge = (ipc: Pick<IpcRenderer, "invoke">): DesktopNetwork => ({
  list: () => ipc.invoke(NETWORK_LIST),
  revoke: ({ host, port, privateNetwork }) =>
    ipc.invoke(NETWORK_REVOKE, { host, port, privateNetwork }),
  listPaths: () => ipc.invoke(PATHS_LIST),
  revokePath: (path) => ipc.invoke(PATHS_REVOKE, { path }),
  localAllowed: () => ipc.invoke(LOCAL_GET),
  revokeLocal: () => ipc.invoke(LOCAL_REVOKE),
  agent: () => ipc.invoke(AGENT_GET),
  chooseAgent: (socket) => ipc.invoke(AGENT_CHOOSE, { socket }),
});
