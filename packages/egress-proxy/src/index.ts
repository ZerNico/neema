export interface CommandContext {
  readonly server: string;
  readonly chat: string;
  readonly attempt: string;
  readonly command: string;
}

export type GrantDecision =
  | {
      readonly allowed: true;
      /** Non-blank: revoking this grant closes the tunnels it allowed. */
      readonly grantId: string;
      /** True when the grant opts this host:port into private-network addresses. */
      readonly privateNetwork?: boolean;
    }
  | {
      readonly allowed: false;
      /** Why it was refused, for the denial body and the violation. */
      readonly reason?: string;
    };

export interface Denial {
  readonly context: CommandContext;
  readonly host: string;
  readonly port: number;
  readonly reason: string;
  /**
   * What would let it through: a grant for this host and port (`decide` refused), one that also
   * opts into private-network addresses (only such addresses were refused), or nothing.
   */
  readonly lift: "grant" | "private-network" | null;
}

export interface ProxyOptions {
  /** Synchronous: the proxy never prompts. Receives canonical host and port. */
  readonly decide: (context: CommandContext, host: string, port: number) => GrantDecision;
  readonly onDenial: (denial: Denial) => void;
  /** The signal aborts when the connection no longer needs the answer. */
  readonly resolve?: (
    host: string,
    signal: AbortSignal,
  ) => Promise<ReadonlyArray<{ address: string; family: 4 | 6 }>>;
  readonly interfaceAddresses?: () => ReadonlyArray<string>;
  /**
   * A destination the host serves itself, such as the SSH agent: returns a connector
   * for a still-connecting socket, `null` to refuse it, or undefined to resolve and
   * dial as usual. Asked only after `decide` allowed the destination; the address
   * guard does not apply. `proven` is false on a command's own port when the client
   * did not also present the command's token: anyone local can reach that port.
   */
  readonly local?: (
    context: CommandContext,
    host: string,
    port: number,
    proven: boolean,
  ) => (() => import("node:net").Socket) | null | undefined;
  /** Must return a socket that is still connecting; the proxy waits for its connect event. */
  readonly connect?: (address: string, port: number, family: 4 | 6) => import("node:net").Socket;
  /** Defaults to console. Receives only fixed diagnostics and validated numeric addresses. */
  readonly log?: (level: "info" | "warn" | "error", message: string) => void;
  readonly limits?: Partial<{
    /** Incomplete-header deadline, default 10 seconds. */
    headerMs: number;
    /** Response flush backstop, default one second. */
    responseCloseMs: number;
    /** Accepted sockets until establishment or closure, default 512. */
    connectionsTotal: number;
    /** Defaults to tunnelsPerToken. Released only when DNS settles. */
    outstandingResolutionsPerToken: number;
    /** Defaults to tunnelsTotal. Released only when DNS settles. */
    outstandingResolutionsTotal: number;
    establishMs: number;
    /** One address's connect attempt while others remain to try, default 5 seconds. */
    attemptMs: number;
    idleMs: number;
    earlyBytes: number;
    earlyBytesTotal: number;
    tunnelsPerToken: number;
    tunnelsTotal: number;
  }>;
  readonly timers?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
}

export interface EgressProxy {
  listen(): Promise<{ port: number }>;
  issue(context: CommandContext): { token: string; proxyUrl: string };
  /**
   * A listener of the command's own, whose connections need no credentials: for
   * a sandbox that reaches only that one port and refuses a URL carrying them.
   * The token still revokes it, which also closes the listener.
   */
  issuePort(context: CommandContext): Promise<{ token: string; proxyUrl: string }>;
  revoke(token: string): void;
  regrant(grantId: string): void;
  tunnels(): ReadonlyArray<{
    context: CommandContext;
    host: string;
    port: number;
    grantId?: string;
  }>;
  close(): Promise<void>;
}

export { createEgressProxy } from "./proxy.ts";
export { canonicalHost } from "./host.ts";
export { addressRefusal } from "./address-guard.ts";
export { childEnvironment } from "./environment.ts";
