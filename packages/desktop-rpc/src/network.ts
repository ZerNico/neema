/**
 * What Work may reach on this computer for every chat: network destinations
 * and readable paths. Machine-local, independent of the Work protocol version.
 */
export interface NetworkGrant {
  readonly host: string;
  readonly port: number;
  readonly privateNetwork: boolean;
}

export const NETWORK_LIST = "chat-desktop:network-list" as const;
export const NETWORK_REVOKE = "chat-desktop:network-revoke" as const;
export const PATHS_LIST = "chat-desktop:paths-list" as const;
export const PATHS_REVOKE = "chat-desktop:paths-revoke" as const;

export interface DesktopNetwork {
  list(): Promise<NetworkGrant[]>;
  revoke(grant: NetworkGrant): Promise<void>;
  listPaths(): Promise<string[]>;
  revokePath(path: string): Promise<void>;
}

export function readDesktopNetwork(): DesktopNetwork | null {
  const channel = Reflect.get(globalThis, "__chatDesktop");
  if (typeof channel !== "object" || channel === null) return null;
  const network = Reflect.get(channel, "network");
  if (typeof network !== "object" || network === null) return null;
  for (const method of ["list", "revoke", "listPaths", "revokePath"])
    if (typeof Reflect.get(network, method) !== "function") return null;
  return network as DesktopNetwork;
}
