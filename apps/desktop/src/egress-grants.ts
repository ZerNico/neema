import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalHost, type CommandContext, type GrantDecision } from "@chat/egress-proxy";
import { serialWrites, writeJsonAtomic } from "./json-file.ts";

/**
 * Where a sandboxed command may connect, decided per connection by the egress
 * proxy. Grants are exact host:port pairs in one of three scopes the person
 * picked on the approval card; the built-in list covers package registries.
 *
 * Consent is local: the file lives in the profile, beside the folder grants,
 * keyed by server origin and conversation like them.
 */
export type GrantScope = "always" | "chat" | "answer";

export interface EgressGrant {
  readonly host: string;
  readonly port: number;
  /** Opts this exact host:port into private-network addresses. */
  readonly privateNetwork: boolean;
}

export interface ChatKey {
  readonly origin: string;
  readonly conversationId: string;
}

export interface AnswerKey extends ChatKey {
  readonly attempt: string;
}

export type GrantTarget =
  | { readonly scope: "always" }
  | { readonly scope: "chat"; readonly chat: ChatKey }
  | { readonly scope: "answer"; readonly answer: AnswerKey };

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
];

const builtInId = (pattern: string) => `builtin ${pattern}`;

const matchesBuiltIn = (pattern: string, host: string) =>
  pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern;

// Names that only ever resolve on a private network; an ordinary grant for one could never connect.
const PRIVATE_SUFFIXES = [".local", ".internal", ".lan", ".home.arpa"];

/**
 * A grant the person can approve: one canonical name or literal and one port.
 * Private-only names and literals need the private-network kind.
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
    const privateName =
      canonical.host === "localhost" ||
      canonical.host.endsWith(".localhost") ||
      PRIVATE_SUFFIXES.some((suffix) => canonical.host.endsWith(suffix));
    if (privateName && !privateNetwork) return null;
  } else if (!privateNetwork) {
    return null;
  }
  return { host: canonical.host, port, privateNetwork };
};

const chatKey = ({ origin, conversationId }: ChatKey) => `${origin} ${conversationId}`;
const answerKey = (answer: AnswerKey) => `${chatKey(answer)} ${answer.attempt}`;
const entryKey = ({ host, port, privateNetwork }: EgressGrant) =>
  `${privateNetwork ? "private" : "public"} ${host}:${port}`;

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

export interface EgressGrants {
  readonly directory: string;
  /** The proxy's callback: synchronous, never prompts. */
  decide(context: CommandContext, host: string, port: number): GrantDecision;
  list(target: GrantTarget): readonly EgressGrant[];
  /** Resolves to the grant's id. */
  add(target: GrantTarget, grant: EgressGrant): Promise<string>;
  /** Resolves to the removed grant's id, for the proxy to close what it allowed. */
  remove(target: GrantTarget, grant: EgressGrant): Promise<string>;
  /** Drops an answer's grants when the answer ends; returns their ids. */
  endAnswer(answer: AnswerKey): readonly string[];
  /** Drops a deleted chat's grants, its answers' included; returns their ids. */
  forgetChat(chat: ChatKey): Promise<readonly string[]>;
}

interface Stored {
  always: EgressGrant[];
  chats: Record<string, EgressGrant[]>;
}

const parseEntries = (value: unknown): EgressGrant[] => {
  if (!Array.isArray(value)) return [];
  const entries = new Map<string, EgressGrant>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { host, port, privateNetwork } = entry as Record<string, unknown>;
    if (typeof privateNetwork !== "boolean") continue;
    const grant = normalizeEgressGrant(host, port, privateNetwork);
    // Only entries already in canonical form: a file rewritten by hand cannot widen a grant.
    if (grant && grant.host === host) entries.set(entryKey(grant), grant);
  }
  return [...entries.values()];
};

const parseStored = (value: unknown): Stored => {
  if (typeof value !== "object" || value === null) return { always: [], chats: {} };
  const { always, chats } = value as Record<string, unknown>;
  const parsed: Stored = { always: parseEntries(always), chats: {} };
  if (typeof chats === "object" && chats !== null) {
    for (const [key, entries] of Object.entries(chats)) {
      const grants = parseEntries(entries);
      if (grants.length > 0) parsed.chats[key] = grants;
    }
  }
  return parsed;
};

const sameGrant = (a: EgressGrant, b: EgressGrant) => entryKey(a) === entryKey(b);

export const loadEgressGrants = async (directory: string): Promise<EgressGrants> => {
  const file = join(directory, "egress-grants.json");
  let stored: Stored = { always: [], chats: {} };
  try {
    stored = parseStored(JSON.parse(await readFile(file, "utf8")));
  } catch {
    // A lost or invalid file leaves only the built-in list, never a broader one.
  }
  const answers = new Map<string, EgressGrant[]>();
  const queue = serialWrites();
  // The next state is built inside the queue, so overlapping changes never drop each other.
  const persist = (update: (current: Stored) => Stored) =>
    queue(async () => {
      const next = update(stored);
      await writeJsonAtomic(file, next);
      stored = next;
    });

  const entries = (target: GrantTarget): readonly EgressGrant[] =>
    target.scope === "always"
      ? stored.always
      : target.scope === "chat"
        ? (stored.chats[chatKey(target.chat)] ?? [])
        : (answers.get(answerKey(target.answer)) ?? []);

  const checked = (grant: EgressGrant) => {
    const valid = normalizeEgressGrant(grant.host, grant.port, grant.privateNetwork);
    if (!valid || valid.host !== grant.host) throw new Error("Invalid network permission.");
    return valid;
  };

  const change = async (target: GrantTarget, grant: EgressGrant, add: boolean) => {
    const valid = checked(grant);
    const id = grantId(target, valid);
    const edit = (current: readonly EgressGrant[]) => {
      const without = current.filter((entry) => !sameGrant(entry, valid));
      return add ? [...without, valid] : without;
    };
    if (target.scope === "answer") {
      const key = answerKey(target.answer);
      const next = edit(answers.get(key) ?? []);
      if (next.length > 0) answers.set(key, next);
      else answers.delete(key);
    } else if (target.scope === "always") {
      await persist((current) => ({ ...current, always: edit(current.always) }));
    } else {
      const key = chatKey(target.chat);
      await persist((current) => {
        const chats = { ...current.chats };
        const next = edit(chats[key] ?? []);
        if (next.length > 0) chats[key] = next;
        else delete chats[key];
        return { ...current, chats };
      });
    }
    return id;
  };

  const find = (target: GrantTarget, host: string, port: number, privateOnly: boolean) =>
    entries(target).find(
      (entry) =>
        entry.host === host && entry.port === port && (!privateOnly || entry.privateNetwork),
    );

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
      for (const privateOnly of [true, false]) {
        for (const target of targets) {
          const entry = find(target, host, port, privateOnly);
          if (entry)
            return {
              allowed: true,
              grantId: grantId(target, entry),
              privateNetwork: entry.privateNetwork,
            };
        }
      }
      if (port === 443) {
        const pattern = BUILT_IN.find((candidate) => matchesBuiltIn(candidate, host));
        if (pattern) return { allowed: true, grantId: builtInId(pattern) };
      }
      return { allowed: false, reason: `No permission for ${host}:${port}` };
    },
    list: (target) => [...entries(target)],
    add: (target, grant) => change(target, grant, true),
    remove: (target, grant) => change(target, grant, false),
    endAnswer: (answer) => {
      const key = answerKey(answer);
      const ended = answers.get(key) ?? [];
      answers.delete(key);
      return ended.map((grant) => grantId({ scope: "answer", answer }, grant));
    },
    forgetChat: async (chat) => {
      const prefix = `${chatKey(chat)} `;
      const ids: string[] = [];
      for (const [key, grants] of answers) {
        if (!key.startsWith(prefix)) continue;
        const attempt = key.slice(prefix.length);
        for (const grant of grants)
          ids.push(grantId({ scope: "answer", answer: { ...chat, attempt } }, grant));
        answers.delete(key);
      }
      await persist((current) => {
        const key = chatKey(chat);
        for (const grant of current.chats[key] ?? [])
          ids.push(grantId({ scope: "chat", chat }, grant));
        const chats = { ...current.chats };
        delete chats[key];
        return { ...current, chats };
      });
      return ids;
    },
  };
};
