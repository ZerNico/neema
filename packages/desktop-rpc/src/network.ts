/** Optional machine-local network permissions, independent of the Work protocol version. */
export interface NetworkGrant {
  readonly host: string;
}

export const NETWORK_LIST = "chat-desktop:network-list" as const;
export const NETWORK_REVOKE = "chat-desktop:network-revoke" as const;

export interface DesktopNetwork {
  list(): Promise<NetworkGrant[]>;
  revoke(host: string): Promise<void>;
}

export function readDesktopNetwork(): DesktopNetwork | null {
  const channel = Reflect.get(globalThis, "__chatDesktop");
  if (typeof channel !== "object" || channel === null) return null;
  const network = Reflect.get(channel, "network");
  if (typeof network !== "object" || network === null) return null;
  if (typeof network.list !== "function" || typeof network.revoke !== "function") return null;
  return network as DesktopNetwork;
}
