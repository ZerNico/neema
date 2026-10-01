import { describe, expect, it } from "vitest";
import {
  BROWSER_PROFILE_ARGUMENT,
  isBrowserPartition,
  profileFromArgv,
  sharedPartition,
  temporaryPartition,
} from "./partitions.ts";
import { browserProfile } from "./profile.ts";

describe("browser partitions", () => {
  const profile = browserProfile("https://chat.example.com");

  it("gives each server its own persistent profile", () => {
    expect(profile).toMatch(/^[0-9a-f]{16}$/);
    expect(browserProfile("https://other.example.com")).not.toBe(profile);
    expect(sharedPartition(profile)).toBe(`persist:browser-${profile}`);
  });

  it("admits only this server's shared and temporary partitions", () => {
    const other = browserProfile("https://other.example.com");
    expect(isBrowserPartition(profile, sharedPartition(profile))).toBe(true);
    expect(isBrowserPartition(profile, temporaryPartition(profile, "0a1b-2c3d"))).toBe(true);
    expect(temporaryPartition(profile, "x").startsWith("persist:")).toBe(false);
    for (const partition of [
      sharedPartition(other),
      temporaryPartition(other, "0a1b"),
      temporaryPartition(profile, ""),
      temporaryPartition(profile, "../escape"),
      "persist:main",
      "",
    ])
      expect(isBrowserPartition(profile, partition)).toBe(false);
  });

  it("reads the profile main passed, refusing anything else", () => {
    expect(profileFromArgv(["x", `${BROWSER_PROFILE_ARGUMENT}=${profile}`])).toBe(profile);
    expect(profileFromArgv([`${BROWSER_PROFILE_ARGUMENT}=nothex`])).toBeNull();
    expect(profileFromArgv([])).toBeNull();
  });
});
