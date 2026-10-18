import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSiteGrants, siteOf } from "./site-grants.ts";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "site-grants-"));
});
afterEach(() => rm(directory, { recursive: true, force: true }));

const origin = "https://chat.example.com";

describe("siteOf", () => {
  it("groups a site's hosts under its registrable domain", () => {
    expect(siteOf("https://mail.google.com/x")).toBe("google.com");
    expect(siteOf("https://accounts.google.com")).toBe("google.com");
    expect(siteOf("https://news.bbc.co.uk")).toBe("bbc.co.uk");
    // Private suffixes count, so one user's pages never approve another's.
    expect(siteOf("https://alice.github.io")).toBe("alice.github.io");
    expect(siteOf("http://localhost:3000/a")).toBe("localhost");
    expect(siteOf("file:///etc/passwd")).toBeNull();
    expect(siteOf("not a url")).toBeNull();
  });
});

describe("site grants", () => {
  it("allows a site in one chat, or everywhere, and survives a reload", async () => {
    const grants = await loadSiteGrants(directory);
    expect(grants.allowed(origin, "c1", "https://docs.google.com")).toBe(false);
    await grants.allow(origin, "c1", "https://mail.google.com", "chat");
    expect(grants.allowed(origin, "c1", "https://docs.google.com")).toBe(true);
    expect(grants.allowed(origin, "c2", "https://docs.google.com")).toBe(false);
    await grants.allow(origin, "c1", "https://github.com", "always");
    expect(grants.allowed(origin, "c2", "https://gist.github.com")).toBe(true);
    expect(grants.allowed("https://other.example.com", "c2", "https://github.com")).toBe(false);

    const reloaded = await loadSiteGrants(directory);
    expect(reloaded.always(origin)).toEqual(["github.com"]);
    expect(reloaded.allowed(origin, "c1", "https://docs.google.com")).toBe(true);
    await reloaded.revoke(origin, "github.com");
    expect(reloaded.allowed(origin, "c2", "https://github.com")).toBe(false);
  });

  it("forgets the chats granted to longest ago, keeping a chat granted to again", async () => {
    const grants = await loadSiteGrants(directory);
    await grants.allow(origin, "first", "https://a.test", "chat");
    await grants.allow(origin, "second", "https://a.test", "chat");
    await Promise.all(
      Array.from({ length: 498 }, (_, index) =>
        grants.allow(origin, `c${index}`, "https://a.test", "chat"),
      ),
    );
    await grants.allow(origin, "first", "https://b.test", "chat");
    await grants.allow(origin, "last", "https://a.test", "chat");
    expect(grants.allowed(origin, "first", "https://a.test")).toBe(true);
    expect(grants.allowed(origin, "second", "https://a.test")).toBe(false);
    expect(grants.allowed(origin, "last", "https://a.test")).toBe(true);
  });

  it("forgets a deleted chat's sites, and only that chat's", async () => {
    const grants = await loadSiteGrants(directory);
    await grants.allow(origin, "gone", "https://example.org", "chat");
    await grants.allow(origin, "kept", "https://example.org", "chat");
    await grants.forgetChat(origin, "gone");
    const reloaded = await loadSiteGrants(directory);
    expect(reloaded.allowed(origin, "gone", "https://example.org")).toBe(false);
    expect(reloaded.allowed(origin, "kept", "https://example.org")).toBe(true);
  });

  it("grants nothing from a damaged file", async () => {
    await writeFile(join(directory, "browser-sites.json"), "{not json");
    const grants = await loadSiteGrants(directory);
    expect(grants.allowed(origin, "c1", "https://github.com")).toBe(false);
    await grants.allow(origin, "c1", "https://github.com", "always");
    expect(JSON.parse(await readFile(join(directory, "browser-sites.json"), "utf8"))).toEqual({
      always: { [origin]: ["github.com"] },
      chats: {},
    });
  });
});
