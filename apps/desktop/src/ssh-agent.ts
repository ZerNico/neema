import { access, readFile, readdir } from "node:fs/promises";
import { connect } from "node:net";
import { isAbsolute, join } from "node:path";
import { serialWrites, writeJsonAtomic } from "./json-file.ts";

/** Where Windows' own OpenSSH agent listens. It never sets SSH_AUTH_SOCK. */
export const WINDOWS_AGENT = "\\\\.\\pipe\\openssh-ssh-agent";

/**
 * The destination a Windows command asks the egress proxy for to reach the
 * agent. `.invalid` never resolves, so it cannot name a real host.
 */
export const AGENT_DESTINATION = { host: "ssh-agent.invalid", port: 1 } as const;

export interface AgentLookup {
  readonly os: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  /** The socket the person chose in Settings, if any. */
  readonly chosen: string | null;
  readonly exists: (path: string) => Promise<boolean>;
}

/**
 * The agent a chat's commands may sign in with: the socket the person chose (1Password and
 * Secretive set theirs only in ssh's config, which is not read to find it), else SSH_AUTH_SOCK,
 * else Windows' own pipe. One that is not there counts as none.
 */
export const findAgent = async ({ os, env, chosen, exists }: AgentLookup) => {
  const agent =
    chosen ??
    (env.SSH_AUTH_SOCK && isAbsolute(env.SSH_AUTH_SOCK) ? env.SSH_AUTH_SOCK : null) ??
    (os === "win32" ? WINDOWS_AGENT : null);
  return agent && (await exists(agent)) ? agent : null;
};

/** An agent that sets its socket only in ssh's config, where it puts it on this system. */
export interface KnownAgent {
  readonly name: string;
  readonly socket: string;
}

/**
 * Where password managers and key apps put their agent's socket, so Settings can offer the ones
 * found by name. A fixed list, never a path the page names.
 */
export const knownAgents = (os: NodeJS.Platform, home: string): KnownAgent[] =>
  os === "darwin"
    ? [
        {
          name: "1Password",
          socket: join(home, "Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"),
        },
        {
          name: "Secretive",
          socket: join(
            home,
            "Library/Containers/com.maxgoedjen.Secretive.SecretAgent/Data/socket.ssh",
          ),
        },
        {
          name: "Bitwarden",
          socket: join(
            home,
            "Library/Containers/com.bitwarden.desktop/Data/.bitwarden-ssh-agent.sock",
          ),
        },
        { name: "Bitwarden", socket: join(home, ".bitwarden-ssh-agent.sock") },
      ]
    : os === "linux"
      ? [
          { name: "1Password", socket: join(home, ".1password/agent.sock") },
          { name: "Bitwarden", socket: join(home, ".bitwarden-ssh-agent.sock") },
        ]
      : [];

/** The most an identities answer may take before the socket counts as no agent. */
const MAX_ANSWER = 256 * 1024;

/**
 * Whether `frame` (length, then payload) is a whole identities answer: type 12, a key count,
 * then that many key blobs and comments, nothing left over.
 */
export const isIdentitiesAnswer = (frame: Buffer) => {
  if (frame.length < 9 || frame.readUInt32BE(0) !== frame.length - 4 || frame[4] !== 12)
    return false;
  let offset = 9;
  const skipString = () => {
    if (offset + 4 > frame.length) return false;
    const length = frame.readUInt32BE(offset);
    offset += 4 + length;
    return offset <= frame.length;
  };
  for (let key = 0; key < frame.readUInt32BE(5); key += 1)
    if (!skipString() || !skipString()) return false;
  return offset === frame.length;
};

/**
 * How many keys `socket` holds, asked as an SSH agent is asked for its identities; null when it
 * does not answer as one. Settings is a page the server serves, so a socket it names (Docker's)
 * must prove it is an agent.
 */
export const agentKeyCount = (socket: string, timeoutMs = 2_000) =>
  new Promise<number | null>((resolve) => {
    const connection = connect({ path: socket });
    const timer = setTimeout(() => done(null), timeoutMs);
    timer.unref();
    function done(answer: number | null) {
      clearTimeout(timer);
      connection.destroy();
      resolve(answer);
    }
    let received = Buffer.alloc(0);
    // SSH_AGENTC_REQUEST_IDENTITIES: length 1, type 11. The answer is type 12.
    connection.on("connect", () => connection.write(Buffer.from([0, 0, 0, 1, 11])));
    connection.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length < 4) return;
      const whole = 4 + received.readUInt32BE(0);
      if (whole > MAX_ANSWER || received.length > whole) done(null);
      else if (received.length === whole)
        done(isIdentitiesAnswer(received) ? received.readUInt32BE(5) : null);
    });
    connection.on("error", () => done(null));
    connection.on("close", () => done(null));
  });

/** Whether `socket` answers as an SSH agent. */
export const answersAsAgent = async (socket: string, timeoutMs = 2_000) =>
  (await agentKeyCount(socket, timeoutMs)) !== null;

/** The agent socket the person chose in Settings, kept in the profile. */
export interface AgentChoice {
  current(): string | null;
  set(socket: string | null): Promise<void>;
}

export const loadAgentChoice = async (directory: string): Promise<AgentChoice> => {
  const file = join(directory, "ssh-agent.json");
  let current: string | null = null;
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    const socket =
      parsed && typeof parsed === "object" ? (parsed as { socket?: unknown }).socket : null;
    if (typeof socket === "string" && isAbsolute(socket)) current = socket;
  } catch {
    // A lost or invalid file chooses nothing.
  }
  const queue = serialWrites();
  return {
    current: () => current,
    set: (socket) =>
      queue(async () => {
        await writeJsonAtomic(file, { socket });
        current = socket;
      }),
  };
};

export const pathExists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const PIPES = "\\\\.\\pipe\\";

/**
 * Whether an agent is there. A Windows pipe is looked up in the pipe list: opening it to check
 * takes one of the agent's instances, and a second check right after finds it busy (measured).
 * Windows takes either slash in a pipe's path, `.` or `?` as its device, and names in any case.
 */
export const agentExists = async (
  path: string,
  pipes: () => Promise<string[]> = () => readdir(PIPES),
) => {
  const pipe = /^[\\/]{2}[.?][\\/]pipe[\\/](.+)$/i.exec(path)?.[1]?.toLowerCase();
  if (pipe === undefined) return pathExists(path);
  return (await pipes().catch((): string[] => [])).some((name) => name.toLowerCase() === pipe);
};
