import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { serialWrites, writeJsonAtomic } from "./json-file.ts";
import { pathExists } from "./ssh-agent.ts";

/** The key files ssh tries by default, in its order, that the app offers to add to the agent. */
const DEFAULT_KEYS = ["id_ed25519", "id_ecdsa", "id_rsa"];

/** The person's default SSH keys present in `~/.ssh`. */
export const defaultKeyFiles = async (home: string, exists = pathExists) => {
  const found: string[] = [];
  for (const name of DEFAULT_KEYS) {
    const file = join(home, ".ssh", name);
    if (await exists(file)) found.push(file);
  }
  return found;
};

/**
 * The key files the person agreed to have added to their agent. Asked once: the system agent
 * forgets its keys on a restart, and they are added again when a chat that may sign in needs them.
 */
export interface KeyConsent {
  current(): readonly string[];
  set(keys: readonly string[]): Promise<void>;
}

export const loadKeyConsent = async (directory: string): Promise<KeyConsent> => {
  const file = join(directory, "ssh-keys.json");
  let current: readonly string[] = [];
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    const keys = parsed && typeof parsed === "object" ? (parsed as { keys?: unknown }).keys : null;
    if (Array.isArray(keys))
      current = keys.filter((key): key is string => typeof key === "string" && isAbsolute(key));
  } catch {
    // A lost or invalid file agrees to nothing.
  }
  const queue = serialWrites();
  return {
    current: () => current,
    set: (keys) =>
      queue(async () => {
        await writeJsonAtomic(file, { keys });
        current = keys;
      }),
  };
};

/**
 * Asks for a key's passphrase in a macOS dialog of its own, so it passes from the person to
 * ssh-add and never through the app or a page. Cancel fails it, which ends ssh-add's asking.
 */
const ASKPASS = `#!/bin/sh
exec /usr/bin/osascript -e 'on run argv' -e 'display dialog (item 1 of argv) default answer "" with hidden answer with title "neema" with icon note' -e 'text returned of result' -e 'end run' "$1"
`;

const ADD_TIMEOUT_MS = 5 * 60_000;

/**
 * Adds `keys` to the agent at `socket` with ssh-add, outside the sandbox. On macOS Apple's own
 * ssh-add keeps a passphrase in the Keychain, so a key that has one is asked for once. Elsewhere a
 * key with a passphrase is added only if the desktop's own askpass answers. Resolves when ssh-add
 * ends, added or not: the caller counts the agent's keys.
 */
export const addKeysToAgent = async ({
  os,
  socket,
  keys,
  directory,
}: {
  os: NodeJS.Platform;
  socket: string;
  keys: readonly string[];
  /** A folder of the app's own, which no command may write, for the askpass script. */
  directory: string;
}) => {
  const env: NodeJS.ProcessEnv = { ...process.env, SSH_AUTH_SOCK: socket };
  let program = "ssh-add";
  let args = [...keys];
  if (os === "darwin") {
    const askpass = join(directory, "ssh-askpass");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(askpass, ASKPASS, { mode: 0o700 });
    // The mode above applies only when the file is created.
    await chmod(askpass, 0o700);
    program = "/usr/bin/ssh-add";
    args = ["--apple-use-keychain", ...keys];
    Object.assign(env, { SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force" });
  } else if (!env.SSH_ASKPASS) env.SSH_ASKPASS_REQUIRE = "never";
  await new Promise<void>((resolve) => {
    // Detached, so ssh-add has no terminal to ask on when the app was started from one. That makes
    // it a process group's leader, and the group is stopped together, the askpass dialog with it.
    const child = spawn(program, args, { env, stdio: "ignore", detached: true });
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid);
      } catch {
        child.kill();
      }
    }, ADD_TIMEOUT_MS);
    const end = () => {
      clearTimeout(timer);
      resolve();
    };
    child.on("error", end);
    child.on("close", end);
  });
};
