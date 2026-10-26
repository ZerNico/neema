import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
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

export const loadMachineIdentity = async (userData: string): Promise<MachineIdentity> => {
  const file = join(userData, "machine.json");
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { id?: unknown }).id === "string" &&
      typeof (parsed as { name?: unknown }).name === "string"
    ) {
      return parsed as MachineIdentity;
    }
  } catch {
    // Missing or corrupt: fall through and mint. Losing it is a supported
    // outcome; the site offers take-over, never a hard failure.
  }
  const identity: MachineIdentity = { id: randomUUID(), name: defaultName() };
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(identity, null, 2), "utf8");
  await rename(tmp, file);
  return identity;
};
