import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  conflictsWithNetworkGrants,
  loadNetworkGrants,
  networkGrantsDirectory,
  normalizeNetworkGrant,
} from "./network-grants.ts";

const roots: string[] = [];
const temporary = async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-network-grants-"));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("profile network grants", () => {
  it("only accepts exact public DNS hostnames without ports", () => {
    expect(normalizeNetworkGrant("EXAMPLE.COM.")).toEqual({ host: "example.com" });
    for (const host of [
      "*",
      "*.example.com",
      "github.com.evil/",
      "https://example.com",
      "127.0.0.1",
      "[::1]",
      "localhost",
      "service.local",
      "my.lan",
      "example.com:443",
      "user@example.com",
      "bad..example.com",
      "2852039166",
      "example.com\nAllow",
      "example.com ",
      "example.com.evil\u0000",
    ])
      expect(normalizeNetworkGrant(host)).toBeNull();
  });

  it("persists serialized additions and removals across restarts", async () => {
    const directory = networkGrantsDirectory(await temporary());
    const grants = await loadNetworkGrants(directory);
    const a = { host: "example.com" };
    const b = { host: "example.org" };
    await Promise.all([grants.add(a), grants.add(b)]);
    expect((await loadNetworkGrants(directory)).list()).toEqual([a, b]);
    await grants.remove(a);
    expect((await loadNetworkGrants(directory)).list()).toEqual([b]);
  });

  it("does not load hand-edited wildcards or invalid entries", async () => {
    const directory = networkGrantsDirectory(await temporary());
    await mkdir(directory);
    await writeFile(
      join(directory, "approved.json"),
      JSON.stringify([
        "*",
        "example.com",
        "127.0.0.1",
        "example.org:443",
        "EXAMPLE.NET",
        { host: "example.org", port: 80 },
        null,
        443,
      ]),
    );
    const grants = await loadNetworkGrants(directory);
    expect(grants.list()).toEqual([{ host: "example.com" }]);
    await grants.add({ host: "example.net" });
    expect(JSON.parse(await readFile(join(directory, "approved.json"), "utf8"))).toEqual([
      "example.com",
      "example.net",
    ]);
  });

  it("protects the directory and its ancestors, not sibling workspaces", async () => {
    const root = await temporary();
    const directory = networkGrantsDirectory(root);
    expect(conflictsWithNetworkGrants(directory, root)).toBe(true);
    expect(conflictsWithNetworkGrants(directory, directory)).toBe(true);
    expect(conflictsWithNetworkGrants(directory, join(directory, "approved.json"))).toBe(true);
    expect(conflictsWithNetworkGrants(directory, join(root, "workspaces", "chat"))).toBe(false);
  });
});
