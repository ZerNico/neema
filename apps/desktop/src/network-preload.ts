import type { IpcRenderer } from "electron";
import { NETWORK_LIST, NETWORK_REVOKE, type DesktopNetwork } from "@chat/desktop-rpc";

export const makeNetworkBridge = (ipc: Pick<IpcRenderer, "invoke">): DesktopNetwork => ({
  list: () => ipc.invoke(NETWORK_LIST),
  revoke: (host) => ipc.invoke(NETWORK_REVOKE, { host }),
});
