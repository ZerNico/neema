import { Schema } from "effect";
import { NetworkPort } from "./schema.ts";

/**
 * What Work may reach on this computer for every chat: network destinations
 * and readable paths. Machine-local, independent of the Work protocol version.
 * Main decodes each payload below before acting on it.
 */
export const NetworkGrant = Schema.Struct({
  host: Schema.String,
  port: NetworkPort,
  privateNetwork: Schema.Boolean,
});
export type NetworkGrant = typeof NetworkGrant.Type;

/** The payload of `PATHS_REVOKE`. */
export const PathRevokePayload = Schema.Struct({ path: Schema.String });
/** The payload of `AGENT_CHOOSE`: a socket to use, or null to go back to the default. */
export const AgentChoicePayload = Schema.Struct({ socket: Schema.NullOr(Schema.String) });
/** Every other settings channel carries nothing. */
export const NoPayload = Schema.Undefined;

export const NETWORK_LIST = "chat-desktop:network-list" as const;
export const NETWORK_REVOKE = "chat-desktop:network-revoke" as const;
export const PATHS_LIST = "chat-desktop:paths-list" as const;
export const PATHS_REVOKE = "chat-desktop:paths-revoke" as const;
export const LOCAL_GET = "chat-desktop:local-get" as const;
export const LOCAL_ALLOW = "chat-desktop:local-allow" as const;
export const LOCAL_REVOKE = "chat-desktop:local-revoke" as const;
export const AGENT_GET = "chat-desktop:agent-get" as const;
export const AGENT_CHOOSE = "chat-desktop:agent-choose" as const;
export const AGENT_FORGET_KEYS = "chat-desktop:agent-forget-keys" as const;

/** The SSH agent commands sign in with, and the known ones that could be chosen instead. */
export interface AgentSetting {
  /** The agent in effect, or the chosen one while it isn't running. */
  readonly current: {
    readonly socket: string;
    /** A known agent's name, such as 1Password. */
    readonly name: string | null;
    /** Chosen in Settings, named by SSH_AUTH_SOCK, or Windows' own. */
    readonly source: "chosen" | "environment" | "windows";
    /** False for a chosen agent that isn't running: commands then get none. */
    readonly running: boolean;
    /** How many keys it holds; null when unknown (Windows, or it didn't answer). */
    readonly keys: number | null;
  } | null;
  /** Known agents running on this computer, by their real paths. */
  readonly found: readonly { readonly name: string; readonly socket: string }[];
  /** False on Windows, whose commands use Windows' own agent. */
  readonly choosable: boolean;
  /** The key files the app adds to an empty system agent, by name, as the person agreed. */
  readonly added: readonly string[];
}

/** The outcome of choosing: whether anything changed, or refused with a reason. */
export type AgentChoiceReply =
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly message: string };

export interface DesktopNetwork {
  list(): Promise<NetworkGrant[]>;
  revoke(grant: NetworkGrant): Promise<void>;
  listPaths(): Promise<string[]>;
  revokePath(path: string): Promise<void>;
  /**
   * Whether every chat's commands may use services on this computer, or never may here (Linux
   * commands have their own).
   */
  localServices(): Promise<"allowed" | "asked" | "unavailable">;
  /** Allows them for every chat; the page confirms first. False from builds that asked themselves. */
  allowLocal(): Promise<boolean>;
  revokeLocal(): Promise<void>;
  /** Absent in desktop builds that predate choosing an agent. */
  agent?(): Promise<AgentSetting>;
  /** Uses this socket once it answers as an agent, or clears the choice. */
  chooseAgent?(socket: string | null): Promise<AgentChoiceReply>;
  /** Stops adding the person's key files to the agent; the ones in it stay until it restarts. */
  forgetKeys?(): Promise<void>;
}

export function readDesktopNetwork(): DesktopNetwork | null {
  const channel = Reflect.get(globalThis, "__chatDesktop");
  if (typeof channel !== "object" || channel === null) return null;
  const network = Reflect.get(channel, "network");
  if (typeof network !== "object" || network === null) return null;
  for (const method of [
    "list",
    "revoke",
    "listPaths",
    "revokePath",
    "localServices",
    "allowLocal",
    "revokeLocal",
  ])
    if (typeof Reflect.get(network, method) !== "function") return null;
  return network as DesktopNetwork;
}
