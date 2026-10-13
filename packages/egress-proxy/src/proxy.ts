import { createConnection, createServer } from "node:net";
import { createDefaultResolver } from "./resolver.ts";
import { networkInterfaces } from "node:os";
import type { EgressProxy, ProxyOptions } from "./index.ts";
import { Tokens } from "./auth.ts";
import { Connection, type Services, type Limits } from "./connection.ts";
import { defaultTimers } from "./timers.ts";

function limitsFor(options: ProxyOptions): Limits {
  const supplied = options.limits;
  const limits = {
    headerMs: supplied?.headerMs ?? 10_000,
    responseCloseMs: supplied?.responseCloseMs ?? 1_000,
    connectionsTotal: supplied?.connectionsTotal ?? 512,
    outstandingResolutionsPerToken:
      supplied?.outstandingResolutionsPerToken ?? supplied?.tunnelsPerToken ?? 64,
    outstandingResolutionsTotal:
      supplied?.outstandingResolutionsTotal ?? supplied?.tunnelsTotal ?? 256,
    establishMs: supplied?.establishMs ?? 30_000,
    idleMs: supplied?.idleMs ?? 600_000,
    earlyBytes: supplied?.earlyBytes ?? 64 * 1024,
    earlyBytesTotal: supplied?.earlyBytesTotal ?? 4 * 1024 * 1024,
    tunnelsPerToken: supplied?.tunnelsPerToken ?? 64,
    tunnelsTotal: supplied?.tunnelsTotal ?? 256,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      (name.endsWith("Ms") && (value === 0 || value > 2_147_483_647))
    ) {
      throw new Error(`Invalid proxy limit: ${name}`);
    }
  }
  if (!Number.isSafeInteger(limits.connectionsTotal + limits.tunnelsTotal)) {
    throw new Error("Invalid aggregate socket limit");
  }
  return limits;
}

export function createEgressProxy(options: ProxyOptions): EgressProxy {
  const tokens = new Tokens();
  const connections = new Set<Connection>();
  const limits = limitsFor(options);
  const timers = options.timers ?? defaultTimers;
  const injectedResolve = options.resolve;
  const services: Services = {
    options,
    tokens,
    connections,
    earlyBytes: 0,
    preTunnelConnections: 0,
    reservedTunnels: 0,
    outstandingResolutions: 0,
    log: (level, message) => {
      try {
        if (options.log) options.log(level, message);
        else console[level](message);
      } catch {
        // Diagnostics cannot interrupt cleanup or expose a logger's exception.
      }
    },
    timers,
    limits,
    resolve: injectedResolve
      ? (host, signal) => injectedResolve(host, signal)
      : createDefaultResolver(limits.establishMs, timers),
    interfaceAddresses:
      options.interfaceAddresses ??
      (() =>
        Object.values(networkInterfaces()).flatMap((entries) =>
          (entries ?? []).map(({ address }) => address),
        )),
    connect:
      options.connect ??
      ((address, port, family) =>
        createConnection({ host: address, port, family, allowHalfOpen: true })),
  };
  let closed = false;
  let port: number | undefined;
  let listening: Promise<{ port: number }> | undefined;
  let closing: Promise<void> | undefined;
  const server = createServer({ allowHalfOpen: true }, (client) => {
    if (closed || services.preTunnelConnections >= services.limits.connectionsTotal)
      client.destroy();
    else {
      services.preTunnelConnections++;
      connections.add(new Connection(client, services));
    }
  });
  // Node counts tunnels too; the accept guard independently bounds pre-tunnel sockets.
  server.maxConnections = services.limits.connectionsTotal + services.limits.tunnelsTotal;
  server.on("error", () => services.log("error", "Egress proxy: listener failed"));

  return {
    listen() {
      if (closed) return Promise.reject(new Error("Proxy is closed"));
      listening ??= new Promise((resolve, reject) => {
        const failed = () => {
          server.removeListener("listening", ready);
          reject(new Error("Proxy listener failed"));
        };
        const ready = () => {
          server.removeListener("error", failed);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("Proxy has no TCP listener"));
            return;
          }
          port = address.port;
          resolve({ port });
        };
        server.once("error", failed);
        server.once("listening", ready);
        server.listen(0, "127.0.0.1");
      });
      return listening;
    },
    issue(context) {
      if (closed || port === undefined) throw new Error("Proxy is not listening");
      const token = tokens.issue(context);
      return { token, proxyUrl: `http://cmd:${token}@127.0.0.1:${port}` };
    },
    revoke(token) {
      const identity = tokens.revoke(token);
      if (!identity) return;
      for (const connection of connections) if (connection.identity === identity) connection.stop();
    },
    regrant(grantId) {
      for (const connection of connections) connection.regrant(grantId);
    },
    tunnels() {
      return [...connections].flatMap((connection) => {
        const snapshot = connection.snapshot();
        return snapshot ? [snapshot] : [];
      });
    },
    close() {
      if (closing) return closing;
      closed = true;
      tokens.clear();
      for (const connection of connections) connection.stop();
      closing = (async () => {
        await listening?.catch(() => {});
        if (server.listening)
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
      })();
      return closing;
    },
  };
}
