import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serialWrites, writeJsonAtomic } from "./json-file.ts";

/** This machine's own choices for chats' computers, whichever server it is connected to. */
export interface ComputerSettingsValue {
  /** Whether calls started on the person's other devices may run here. On by default. */
  readonly remote: boolean;
  /** The SSH agent socket chosen in Settings, or null for the default. */
  readonly agentSocket: string | null;
}

const DEFAULTS: ComputerSettingsValue = { remote: true, agentSocket: null };

/** Windows' own OpenSSH agent, which needs no `SSH_AUTH_SOCK`. */
const WINDOWS_AGENT = "\\\\.\\pipe\\openssh-ssh-agent";

/**
 * Read once at start and kept in memory, since the computer asks for both synchronously. A
 * missing or unreadable file is the defaults.
 */
export class ComputerSettings {
  private constructor(
    private readonly file: string,
    private value: ComputerSettingsValue,
  ) {}

  private readonly queue = serialWrites();

  static async load(file: string) {
    const saved = await readFile(file, "utf8")
      .then((text) => JSON.parse(text) as unknown)
      .catch(() => null);
    const record =
      typeof saved === "object" && saved !== null ? (saved as Record<string, unknown>) : {};
    return new ComputerSettings(file, {
      remote: typeof record.remote === "boolean" ? record.remote : DEFAULTS.remote,
      agentSocket: typeof record.agentSocket === "string" ? record.agentSocket : null,
    });
  }

  get(): ComputerSettingsValue {
    return this.value;
  }

  /** The agent chats are relayed to: the chosen one, else the environment's, else Windows' own. */
  agentSocket(env: NodeJS.ProcessEnv = process.env, platform = process.platform) {
    return (
      this.value.agentSocket ??
      (env.SSH_AUTH_SOCK || null) ??
      (platform === "win32" ? WINDOWS_AGENT : null)
    );
  }

  async set(change: Partial<ComputerSettingsValue>) {
    this.value = { ...this.value, ...change };
    const value = this.value;
    await this.queue(() => writeJsonAtomic(this.file, value));
  }
}

export const computerSettingsFile = (userData: string) => join(userData, "computer-settings.json");
