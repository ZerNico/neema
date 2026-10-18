import { join, relative, sep } from "node:path";
import {
  addressRefusal,
  canonicalHost,
  type CommandContext,
  type GrantDecision,
} from "@chat/egress-proxy";
import {
  answerKey,
  chatKey,
  loadScopedGrants,
  type AnswerKey,
  type ChatKey,
  type DroppedGrant,
  type GrantTarget,
} from "./scoped-grants.ts";

/**
 * Where a sandboxed command may connect, decided per connection by the egress
 * proxy. Grants are exact host:port pairs in one of three scopes the person
 * picked on the approval card; the built-in list covers package registries.
 *
 * Consent is local: the file lives in the profile, beside the folder grants,
 * keyed by server origin and conversation like them.
 */
export const networkGrantsDirectory = (userData: string) => join(userData, "network-grants");

const inside = (parent: string, child: string) => {
  const rest = relative(parent, child);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !rest.startsWith(sep));
};

/** A protected path cannot be changed directly or by replacing an ancestor. */
export const conflictsWithNetworkGrants = (directory: string, path: string) =>
  inside(directory, path) || inside(path, directory);

export interface EgressGrant {
  readonly host: string;
  readonly port: number;
  /** Opts this exact host:port into private-network addresses. */
  readonly privateNetwork: boolean;
}

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
];

const builtInId = (pattern: string) => `builtin ${pattern}`;

const matchesBuiltIn = (pattern: string, host: string) =>
  pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern;

// Names that only ever resolve on a private network; an ordinary grant for one could never connect.
const PRIVATE_SUFFIXES = [".local", ".internal", ".lan", ".home.arpa"];

/**
 * A grant the person can approve: one canonical name or literal and one port.
 * Private-only names and addresses need the private-network kind; a public address
 * (a server reached by IP) is an ordinary grant.
 */
export const normalizeEgressGrant = (
  host: unknown,
  port: unknown,
  privateNetwork: boolean,
): EgressGrant | null => {
  if (typeof host !== "string" || typeof port !== "number") return null;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const canonical = canonicalHost(host);
  if (!canonical.ok) return null;
  if (canonical.kind === "name") {
    const labels = canonical.host.split(".");
    if (labels.length < 2 || /^\d+$/.test(labels.at(-1) ?? "")) return null;
    // .invalid never resolves; the agent's reserved destination lives there.
    if (labels.at(-1) === "invalid") return null;
    const privateName =
      canonical.host === "localhost" ||
      canonical.host.endsWith(".localhost") ||
      PRIVATE_SUFFIXES.some((suffix) => canonical.host.endsWith(suffix));
    if (privateName && !privateNetwork) return null;
  } else if (!privateNetwork && addressRefusal(canonical.host, [], false) !== null) {
    // Private, or one the proxy refuses whatever a grant says (loopback, metadata).
    return null;
  }
  return { host: canonical.host, port, privateNetwork };
};

const entryKey = ({ host, port, privateNetwork }: EgressGrant) =>
  `${privateNetwork ? "private" : "public"} ${host}:${port}`;

/** A grant only if already canonical: a file rewritten by hand cannot widen one. */
const canonical = (host: unknown, port: unknown, privateNetwork: boolean) => {
  const grant = normalizeEgressGrant(host, port, privateNetwork);
  return grant && grant.host === host ? grant : null;
};

const parseEntry = (entry: string): EgressGrant | null => {
  const match = /^(private|public) (.+):(\d+)$/.exec(entry);
  if (!match) return null;
  const [, kind, host, port] = match;
  const grant = canonical(host, Number(port), kind === "private");
  return grant && entryKey(grant) === entry ? grant : null;
};

// Earlier versions stored each grant as a {host, port, privateNetwork} object.
const upgradeEntry = (item: unknown) => {
  if (typeof item !== "object" || item === null) return null;
  const { host, port, privateNetwork } = item as Record<string, unknown>;
  if (typeof privateNetwork !== "boolean") return null;
  const grant = canonical(host, port, privateNetwork);
  return grant && entryKey(grant);
};

/** Stable for one grant in one place, so revoking it can find the tunnels it allowed. */
export const grantId = (target: GrantTarget, grant: EgressGrant) => {
  const owner =
    target.scope === "always"
      ? "always"
      : target.scope === "chat"
        ? `chat ${chatKey(target.chat)}`
        : `answer ${answerKey(target.answer)}`;
  return `${owner} ${entryKey(grant)}`;
};

const droppedIds = (dropped: readonly DroppedGrant[]) =>
  dropped.flatMap(({ target, entry }) => {
    const grant = parseEntry(entry);
    return grant ? [grantId(target, grant)] : [];
  });

export interface EgressGrants {
  readonly directory: string;
  /** The proxy's callback: synchronous, never prompts. */
  decide(context: CommandContext, host: string, port: number): GrantDecision;
  list(target: GrantTarget): readonly EgressGrant[];
  /** Resolves to the grant's id. */
  add(target: GrantTarget, grant: EgressGrant): Promise<string>;
  /** Resolves to the removed grant's id, for the proxy to close what it allowed. */
  remove(target: GrantTarget, grant: EgressGrant): Promise<string>;
  /**
   * Ends every answer of this server that is not listed as still running;
   * returns the ended grants' ids.
   */
  keepAnswers(origin: string, live: readonly AnswerKey[]): readonly string[];
  /** Drops a deleted chat's grants, its answers' included; returns their ids. */
  forgetChat(chat: ChatKey): Promise<readonly string[]>;
}

export const loadEgressGrants = async (directory: string): Promise<EgressGrants> => {
  // A lost or invalid file leaves only the built-in list, never a broader one.
  const scoped = await loadScopedGrants(
    directory,
    "egress-grants.json",
    (entry) => parseEntry(entry) !== null,
    upgradeEntry,
  );

  const change = async (target: GrantTarget, grant: EgressGrant, add: boolean) => {
    const valid = canonical(grant.host, grant.port, grant.privateNetwork);
    if (!valid) throw new Error("Invalid network permission.");
    if (add) await scoped.add(target, entryKey(valid));
    else await scoped.remove(target, entryKey(valid));
    return grantId(target, valid);
  };

  return {
    directory,
    decide: (context, host, port) => {
      const chat = { origin: context.server, conversationId: context.chat };
      const targets: GrantTarget[] = [
        { scope: "always" },
        { scope: "chat", chat },
        { scope: "answer", answer: { ...chat, attempt: context.attempt } },
      ];
      // A private-network grant is the stronger permission, so it wins when both exist.
      for (const privateNetwork of [true, false]) {
        const entry = entryKey({ host, port, privateNetwork });
        for (const target of targets) {
          if (scoped.list(target).includes(entry))
            return {
              allowed: true,
              grantId: grantId(target, { host, port, privateNetwork }),
              privateNetwork,
            };
        }
      }
      if (port === 443) {
        const pattern = BUILT_IN.find((candidate) => matchesBuiltIn(candidate, host));
        if (pattern) return { allowed: true, grantId: builtInId(pattern) };
      }
      return { allowed: false, reason: `No permission for ${host}:${port}` };
    },
    list: (target) =>
      scoped.list(target).flatMap((entry) => {
        const grant = parseEntry(entry);
        return grant ? [grant] : [];
      }),
    add: (target, grant) => change(target, grant, true),
    remove: (target, grant) => change(target, grant, false),
    keepAnswers: (origin, live) => droppedIds(scoped.keepAnswers(origin, live)),
    forgetChat: async (chat) => droppedIds(await scoped.forgetChat(chat)),
  };
};
