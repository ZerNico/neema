import { createConnection } from "node:net";
import type { ClientContext, Denial, GrantDecision } from "@chat/egress-proxy";
import type { DestinationGrant } from "@chat/desktop-rpc";

/** Package registries every chat may reach on 443 without asking. */
const BUILT_IN: ReadonlyArray<string> = [
  "registry.npmjs.org",
  "*.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "*.pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "*.crates.io",
  "proxy.golang.org",
  "github.com",
  "*.github.com",
  "objects.githubusercontent.com",
  "repo.maven.apache.org",
  "repo1.maven.org",
  "plugins.gradle.org",
  "services.gradle.org",
  "downloads.gradle.org",
  // The image's apt sources, switched to HTTPS (infra/sandbox-image/Dockerfile).
  "archive.ubuntu.com",
  "security.ubuntu.com",
  "ports.ubuntu.com",
];

/** The name a guest reaches a service on the person's own machine by: host.internal:PORT. */
export const THIS_COMPUTER = "host.internal";

const builtIn = (host: string) =>
  BUILT_IN.find((pattern) =>
    pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern,
  );

const key = (context: ClientContext) => `${context.server}\u0000${context.chat}`;

/**
 * The egress proxy's policy for every chat VM: the built-in registries, plus the grants the
 * server holds for the person and pushes whole each time they change. The proxy asks
 * synchronously, so the grants are kept here, per server.
 */
export class EgressPolicy {
  private readonly grants = new Map<string, ReadonlyArray<DestinationGrant>>();
  /** Per chat, the destinations refused while one of its commands ran. */
  private readonly refused = new Map<string, Set<string>>();

  constructor(private readonly onRegrant: (grantId: string) => void) {}

  /** The server's whole grant list for one origin. Removed grants close their tunnels. */
  setGrants(origin: string, grants: ReadonlyArray<DestinationGrant>) {
    const before = this.grants.get(origin) ?? [];
    this.grants.set(origin, grants);
    const kept = new Set(grants.map((grant) => grant.id));
    for (const grant of before) if (!kept.has(grant.id)) this.onRegrant(grant.id);
  }

  decide = (context: ClientContext, host: string, port: number): GrantDecision => {
    const pattern = port === 443 ? builtIn(host) : undefined;
    if (pattern) return { allowed: true, grantId: `builtin ${pattern}` };
    const grant = (this.grants.get(context.server) ?? []).find(
      (candidate) =>
        candidate.host === host &&
        candidate.port === port &&
        (candidate.conversationId === null || candidate.conversationId === context.chat),
    );
    return grant
      ? { allowed: true, grantId: grant.id, privateNetwork: grant.privateNetwork }
      : { allowed: false, reason: "No grant for host:port" };
  };

  /** A service on this computer, dialled directly once a grant allows `host.internal:port`. */
  local = (_context: ClientContext, host: string, port: number) =>
    host === THIS_COMPUTER
      ? () => createConnection({ host: "127.0.0.1", port, allowHalfOpen: true })
      : undefined;

  onDenial = (denial: Denial) => {
    const set = this.refused.get(key(denial.context));
    if (!set) return;
    const destination = `${denial.host}:${denial.port}`;
    set.add(
      denial.lift === "grant"
        ? `${destination} needs request_network_access`
        : denial.lift === "private-network"
          ? `${destination} needs request_network_access with privateNetwork`
          : `${destination} is refused (${denial.reason})`,
    );
  };

  /** Collects what the chat's VM is refused until the returned function ends it. */
  watch(context: ClientContext) {
    const id = key(context);
    const set = new Set<string>();
    this.refused.set(id, set);
    return () => {
      if (this.refused.get(id) === set) this.refused.delete(id);
      return [...set];
    };
  }
}
