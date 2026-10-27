import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import os from "node:os";

/**
 * This machine's stable identity, which the server binds chats to and routes
 * their computer calls by.
 *
 * Persisted, not derived: a hardware-derived id would change under the user
 * (new Mac, same apps), and a fresh one per launch would make every restart
 * look like a new machine. A reinstall mints a new id, which is the honest
 * answer: the workspaces and grants of the old install are gone with it, and
 * the site treats that exactly like a foreign machine: banner, take over,
 * keep working.
 */
export interface MachineIdentity {
  readonly id: string;
  readonly name: string;
}

/** Hostnames make the friendliest labels; length-capped like any user-facing string. */
const defaultName = () => {
  const host = os
    .hostname()
    .replace(/\.(local|lan)$/, "")
    .trim();
  return (host || "This computer").slice(0, 64);
};

const run = (command: string, args: string[]) =>
  new Promise<string>((resolve) => {
    execFile(command, args, { timeout: 5_000 }, (error, stdout) => resolve(error ? "" : stdout));
  });

/**
 * The hardware the profile was made on, hashed: the platform's own id for this computer, which a
 * copied profile (Migration Assistant, a restored backup) does not bring along. Null when the
 * platform will not say, and then nothing is compared.
 */
export const hardwareFingerprint = async (): Promise<string | null> => {
  let raw = "";
  if (process.platform === "darwin")
    raw =
      /"IOPlatformUUID" = "([^"]+)"/.exec(
        await run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]),
      )?.[1] ?? "";
  else if (process.platform === "win32")
    raw =
      /MachineGuid\s+REG_SZ\s+(\S+)/.exec(
        await run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]),
      )?.[1] ?? "";
  else raw = (await readFile("/etc/machine-id", "utf8").catch(() => "")).trim();
  return raw ? createHash("sha256").update(raw).digest("hex").slice(0, 32) : null;
};

/**
 * Loads the id, or mints one. A profile copied to another computer keeps its file but not its
 * hardware: it gets an id of its own, or the two would take turns being one machine.
 */
export const loadMachineIdentity = async (
  userData: string,
  hardware: () => Promise<string | null> = hardwareFingerprint,
): Promise<MachineIdentity> => {
  const file = join(userData, "machine.json");
  const here = await hardware();
  const save = async (identity: MachineIdentity) => {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const stored = here ? { ...identity, hardware: here } : identity;
    await writeFile(tmp, JSON.stringify(stored, null, 2), "utf8");
    await rename(tmp, file);
  };
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { id?: unknown }).id === "string" &&
      typeof (parsed as { name?: unknown }).name === "string"
    ) {
      const { id, name, hardware: was } = parsed as MachineIdentity & { hardware?: unknown };
      if (typeof was !== "string") {
        // Made before the fingerprint was kept: this computer is taken as its own.
        if (here) await save({ id, name });
        return { id, name };
      }
      if (!here || was === here) return { id, name };
    }
  } catch {
    // Missing or corrupt: fall through and mint. Losing it is a supported
    // outcome; the site offers take-over, never a hard failure.
  }
  const identity: MachineIdentity = { id: randomUUID(), name: defaultName() };
  await save(identity);
  return identity;
};
