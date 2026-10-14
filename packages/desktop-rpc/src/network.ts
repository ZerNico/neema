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
export const LOCAL_GET = "chat-desktop:local-get" as const;
export const LOCAL_REVOKE = "chat-desktop:local-revoke" as const;
export const AGENT_GET = "chat-desktop:agent-get" as const;
export const AGENT_CHOOSE = "chat-desktop:agent-choose" as const;

/** The SSH agent commands sign in with: the socket chosen, and the one used when none is. */
export interface AgentSetting {
  /** The socket chosen, by its real path. */
  readonly chosen: string | null;
  /** Whether the chosen socket is there now; when it is not, commands get no agent. */
  readonly chosenFound: boolean;
  readonly fallback: string | null;
  /** Where the fallback comes from: SSH_AUTH_SOCK, or Windows' own pipe. */
  readonly fallbackFrom: "environment" | "windows" | null;
  /** False on Windows, whose commands use Windows' own agent. */
  readonly choosable: boolean;
}

/** The outcome of choosing: changed, declined in the app's dialog, or refused with a reason. */
export type AgentChoiceReply =
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly message: string };

export interface DesktopNetwork {
  list(): Promise<NetworkGrant[]>;
  revoke(grant: NetworkGrant): Promise<void>;
  listPaths(): Promise<string[]>;
  revokePath(path: string): Promise<void>;
  /** Whether every chat's commands may use local network services. */
  localAllowed(): Promise<boolean>;
  revokeLocal(): Promise<void>;
  /** Absent in desktop builds that predate choosing an agent. */
  agent?(): Promise<AgentSetting>;
  /** Asks the app to use this socket (it confirms with its own dialog), or clears the choice. */
  chooseAgent?(socket: string | null): Promise<AgentChoiceReply>;
}

export function readDesktopNetwork(): DesktopNetwork | null {
  const channel = Reflect.get(globalThis, "__chatDesktop");
  if (typeof channel !== "object" || channel === null) return null;
  const network = Reflect.get(channel, "network");
  if (typeof network !== "object" || network === null) return null;
  for (const method of ["list", "revoke", "listPaths", "revokePath", "localAllowed", "revokeLocal"])
    if (typeof Reflect.get(network, method) !== "function") return null;
  return network as DesktopNetwork;
}
