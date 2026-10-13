import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { grantId, loadEgressGrants, normalizeEgressGrant } from "./egress-grants.ts";

const roots: string[] = [];
const directory = async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-egress-grants-"));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const chat = { origin: "https://chat.example", conversationId: "chat-a" };
const otherChat = { origin: "https://chat.example", conversationId: "chat-b" };
const otherServer = { origin: "https://other.example", conversationId: "chat-a" };
const answer = { ...chat, attempt: "attempt-1" };
const context = (key: { origin: string; conversationId: string }, attempt = "attempt-1") => ({
  server: key.origin,
  chat: key.conversationId,
  attempt,
  command: "command-1",
});
const site = (host: string, port = 443) => ({ host, port, privateNetwork: false });

describe("normalizeEgressGrant", () => {
  it("accepts one canonical public name and port", () => {
    expect(normalizeEgressGrant("Example.COM.", 443, false)).toEqual(site("example.com"));
    expect(normalizeEgressGrant("github.com", 22, false)).toEqual(site("github.com", 22));
  });

  it("refuses ports outside 1 to 65535 and non-integers", () => {
    for (const port of [0, -1, 65_536, 443.5, Number.NaN]) {
      expect(normalizeEgressGrant("example.com", port, false)).toBeNull();
    }
  });

  it("refuses wildcards, URLs, single labels and malformed names", () => {
    for (const host of [
      "*.example.com",
      "https://example.com",
      "example.com:443",
      "user@example.com",
      "bad..example.com",
      "git",
      "example.com\nx",
      "",
    ]) {
      expect(normalizeEgressGrant(host, 443, false)).toBeNull();
    }
  });

  it("needs a private-network grant for literals and private-only names", () => {
    for (const host of ["10.0.0.5", "fd00::1", "git.internal", "nas.local", "router.lan"]) {
      expect(normalizeEgressGrant(host, 443, false)).toBeNull();
      expect(normalizeEgressGrant(host, 443, true)).not.toBeNull();
    }
  });

  it("refuses non-string hosts and non-number ports", () => {
    expect(normalizeEgressGrant(42, 443, false)).toBeNull();
    expect(normalizeEgressGrant("example.com", "443", false)).toBeNull();
  });
});

describe("decide", () => {
  it("allows the built-in registries on 443 only", async () => {
    const grants = await loadEgressGrants(await directory());
    expect(grants.decide(context(chat), "registry.npmjs.org", 443)).toEqual({
      allowed: true,
      grantId: "builtin registry.npmjs.org",
    });
    expect(grants.decide(context(chat), "a.b.github.com", 443)).toMatchObject({ allowed: true });
    expect(grants.decide(context(chat), "github.com", 22).allowed).toBe(false);
    // A wildcard covers subdomains, never the apex or a lookalike.
    expect(grants.decide(context(chat), "npmjs.org", 443).allowed).toBe(false);
    expect(grants.decide(context(chat), "evilnpmjs.org", 443).allowed).toBe(false);
  });

  it("refuses an unknown host and port with a reason", async () => {
    const grants = await loadEgressGrants(await directory());
    expect(grants.decide(context(chat), "example.com", 443)).toEqual({
      allowed: false,
      reason: "No permission for example.com:443",
    });
  });

  it("keeps each scope to its own chat, server and answer", async () => {
    const grants = await loadEgressGrants(await directory());
    await grants.add({ scope: "chat", chat }, site("chat.example.org"));
    await grants.add({ scope: "answer", answer }, site("answer.example.org"));
    await grants.add({ scope: "always" }, site("always.example.org"));

    expect(grants.decide(context(chat), "chat.example.org", 443).allowed).toBe(true);
    expect(grants.decide(context(otherChat), "chat.example.org", 443).allowed).toBe(false);
    expect(grants.decide(context(otherServer), "chat.example.org", 443).allowed).toBe(false);

    expect(grants.decide(context(chat), "answer.example.org", 443).allowed).toBe(true);
    expect(grants.decide(context(chat, "attempt-2"), "answer.example.org", 443).allowed).toBe(
      false,
    );

    for (const key of [chat, otherChat, otherServer]) {
      expect(grants.decide(context(key), "always.example.org", 443).allowed).toBe(true);
    }
  });

  it("matches the exact port", async () => {
    const grants = await loadEgressGrants(await directory());
    await grants.add({ scope: "chat", chat }, site("github.com", 22));
    expect(grants.decide(context(chat), "github.com", 22)).toEqual({
      allowed: true,
      grantId: grantId({ scope: "chat", chat }, site("github.com", 22)),
      privateNetwork: false,
    });
    expect(grants.decide(context(chat), "github.com", 2222).allowed).toBe(false);
  });

  it("prefers a private-network grant so a private answer can connect", async () => {
    const grants = await loadEgressGrants(await directory());
    const internal = { host: "git.example.com", port: 443, privateNetwork: true };
    await grants.add({ scope: "always" }, site("git.example.com"));
    await grants.add({ scope: "chat", chat }, internal);
    expect(grants.decide(context(chat), "git.example.com", 443)).toEqual({
      allowed: true,
      grantId: grantId({ scope: "chat", chat }, internal),
      privateNetwork: true,
    });
    expect(grants.decide(context(otherChat), "git.example.com", 443)).toMatchObject({
      allowed: true,
      privateNetwork: false,
    });
  });
});

describe("changes", () => {
  it("returns the grant id on add and remove", async () => {
    const grants = await loadEgressGrants(await directory());
    const target = { scope: "chat", chat } as const;
    const added = await grants.add(target, site("example.com"));
    expect(added).toBe(grantId(target, site("example.com")));
    expect(await grants.remove(target, site("example.com"))).toBe(added);
    expect(grants.decide(context(chat), "example.com", 443).allowed).toBe(false);
  });

  it("refuses a grant that is not already canonical", async () => {
    const grants = await loadEgressGrants(await directory());
    await expect(grants.add({ scope: "always" }, site("Example.com"))).rejects.toThrow();
    await expect(grants.add({ scope: "always" }, site("10.0.0.1"))).rejects.toThrow();
    expect(grants.list({ scope: "always" })).toEqual([]);
  });

  it("does not lose overlapping changes", async () => {
    const root = await directory();
    const grants = await loadEgressGrants(root);
    await Promise.all(
      ["a.example.com", "b.example.com", "c.example.com"].map((host) =>
        grants.add({ scope: "always" }, site(host)),
      ),
    );
    const reloaded = await loadEgressGrants(root);
    expect(reloaded.list({ scope: "always" }).map(({ host }) => host)).toEqual([
      "a.example.com",
      "b.example.com",
      "c.example.com",
    ]);
  });

  it("keeps always and chat grants across a reload, never answer grants", async () => {
    const root = await directory();
    const grants = await loadEgressGrants(root);
    await grants.add({ scope: "always" }, site("always.example.org"));
    await grants.add({ scope: "chat", chat }, site("chat.example.org", 8443));
    await grants.add({ scope: "answer", answer }, site("answer.example.org"));

    const reloaded = await loadEgressGrants(root);
    expect(reloaded.decide(context(chat), "always.example.org", 443).allowed).toBe(true);
    expect(reloaded.decide(context(chat), "chat.example.org", 8443).allowed).toBe(true);
    expect(reloaded.decide(context(chat), "answer.example.org", 443).allowed).toBe(false);
  });

  it("ends an answer's grants and reports their ids", async () => {
    const grants = await loadEgressGrants(await directory());
    const target = { scope: "answer", answer } as const;
    const id = await grants.add(target, site("example.com"));
    expect(grants.endAnswer(answer)).toEqual([id]);
    expect(grants.decide(context(chat), "example.com", 443).allowed).toBe(false);
    expect(grants.endAnswer(answer)).toEqual([]);
  });

  it("forgets a deleted chat's grants and its answers', and nothing else", async () => {
    const grants = await loadEgressGrants(await directory());
    const chatId = await grants.add({ scope: "chat", chat }, site("chat.example.org"));
    const answerId = await grants.add({ scope: "answer", answer }, site("answer.example.org"));
    await grants.add({ scope: "chat", chat: otherChat }, site("chat.example.org"));
    await grants.add({ scope: "always" }, site("always.example.org"));

    expect([...(await grants.forgetChat(chat))].toSorted()).toEqual([answerId, chatId].toSorted());
    expect(grants.decide(context(chat), "chat.example.org", 443).allowed).toBe(false);
    expect(grants.decide(context(chat), "answer.example.org", 443).allowed).toBe(false);
    expect(grants.decide(context(otherChat), "chat.example.org", 443).allowed).toBe(true);
    expect(grants.decide(context(chat), "always.example.org", 443).allowed).toBe(true);
  });
});

describe("the stored file", () => {
  it("leaves only the built-in list when the file is missing or invalid", async () => {
    const root = await directory();
    await writeFile(join(root, "egress-grants.json"), "{not json");
    const grants = await loadEgressGrants(root);
    expect(grants.list({ scope: "always" })).toEqual([]);
    expect(grants.decide(context(chat), "github.com", 443).allowed).toBe(true);
  });

  it("drops entries that are not canonical or carry the wrong shape", async () => {
    const root = await directory();
    await writeFile(
      join(root, "egress-grants.json"),
      JSON.stringify({
        always: [
          site("ok.example.com"),
          site("Upper.example.com"),
          { host: "no-flag.example.com", port: 443 },
          { host: "10.0.0.1", port: 443, privateNetwork: false },
          { host: "10.0.0.1", port: 443, privateNetwork: true },
          site("*.example.com"),
          "bare.example.com",
        ],
        chats: { "https://chat.example chat-a": [site("chat.example.org", 0)] },
      }),
    );
    const grants = await loadEgressGrants(root);
    expect(grants.list({ scope: "always" })).toEqual([
      site("ok.example.com"),
      { host: "10.0.0.1", port: 443, privateNetwork: true },
    ]);
    expect(grants.list({ scope: "chat", chat })).toEqual([]);
  });

  it("writes the file in the protected directory", async () => {
    const root = await directory();
    const grants = await loadEgressGrants(root);
    await grants.add({ scope: "chat", chat }, site("example.com"));
    expect(JSON.parse(await readFile(join(root, "egress-grants.json"), "utf8"))).toEqual({
      always: [],
      chats: { "https://chat.example chat-a": [site("example.com")] },
    });
  });
});
