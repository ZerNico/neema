import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hardwareFingerprint, loadMachineIdentity } from "./machine.ts";

describe("loadMachineIdentity", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "neema-machine-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("keeps its id on the same computer, and mints a new one on another", async () => {
    const first = await loadMachineIdentity(dir, async () => "mac-a");
    expect(await loadMachineIdentity(dir, async () => "mac-a")).toEqual(first);
    // The profile copied to a new Mac: same file, other hardware.
    const copied = await loadMachineIdentity(dir, async () => "mac-b");
    expect(copied.id).not.toBe(first.id);
    expect(await loadMachineIdentity(dir, async () => "mac-b")).toEqual(copied);
  });

  it("keeps the id when the platform will not say which computer this is", async () => {
    const first = await loadMachineIdentity(dir, async () => "mac-a");
    expect(await loadMachineIdentity(dir, async () => null)).toEqual(first);
  });

  it("reads this computer's own fingerprint", async () => {
    // Every supported platform answers; a stable value, never the raw id.
    const once = await hardwareFingerprint();
    expect(once).toMatch(/^[0-9a-f]{32}$/);
    expect(await hardwareFingerprint()).toBe(once);
  });
});
