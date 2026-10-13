import { execFile } from "node:child_process";
import { access } from "node:fs/promises";

/** Where Windows' own OpenSSH agent listens. It never sets SSH_AUTH_SOCK. */
export const WINDOWS_AGENT = "\\\\.\\pipe\\openssh-ssh-agent";

/**
 * The destination a Windows command asks the egress proxy for to reach the
 * agent. `.invalid` never resolves, so it cannot name a real host.
 */
export const AGENT_DESTINATION = { host: "ssh-agent.invalid", port: 1 } as const;

/**
 * The agent named by `ssh -G`: an IdentityAgent from the user's config (how
 * 1Password and Secretive are usually wired), or SSH_AUTH_SOCK when the config
 * names none or names that variable.
 */
export const agentFromConfig = (output: string, env: NodeJS.ProcessEnv): string | null => {
  const line = output
    .split(/\r?\n/)
    .find((entry) => entry.toLowerCase().startsWith("identityagent "));
  const value = line?.slice("identityagent ".length).trim();
  if (value === undefined || value === "SSH_AUTH_SOCK") return env.SSH_AUTH_SOCK || null;
  if (value === "none") return null;
  if (value.startsWith("$")) return env[value.slice(1)] || null;
  return value;
};

export interface AgentLookup {
  readonly os: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  /** The user's ssh, or null when there is none to ask. */
  readonly ssh: string | null;
  readonly config: (ssh: string) => Promise<string>;
  readonly exists: (path: string) => Promise<boolean>;
}

/**
 * The agent a chat's commands may sign in with, looked up when one is allowed
 * so a changed config or a restarted agent is seen. A host no config names
 * gets only what `Host *` sets, which is what every destination shares.
 */
export const findAgent = async (lookup: AgentLookup): Promise<string | null> => {
  let agent: string | null;
  try {
    agent = lookup.ssh
      ? agentFromConfig(await lookup.config(lookup.ssh), lookup.env)
      : lookup.env.SSH_AUTH_SOCK || null;
  } catch {
    agent = lookup.env.SSH_AUTH_SOCK || null;
  }
  if (agent) return (await lookup.exists(agent)) ? agent : null;
  return lookup.os === "win32" && (await lookup.exists(WINDOWS_AGENT)) ? WINDOWS_AGENT : null;
};

/** Runs the user's ssh to print its effective config; it connects nowhere. */
export const sshConfig = (ssh: string) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      ssh,
      ["-G", "-o", "BatchMode=yes", "agent-lookup.invalid"],
      { timeout: 5_000, encoding: "utf8" },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

export const pathExists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
