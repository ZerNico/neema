import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkPathGrant, loadPathGrants, pathRefusal, touchesDenied } from "./path-grants.ts";

const roots: string[] = [];
const directory = async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-path-grants-"));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const rules = { home: "/Users/alex", denied: ["/Users/alex/.ssh", "/profile/network-grants"] };
const chat = { origin: "https://chat.example", conversationId: "chat-a" };
const answer = { ...chat, attempt: "attempt-1" };

describe("pathRefusal", () => {
  it("allows one thing inside home or elsewhere", () => {
    expect(pathRefusal("/Users/alex/Documents/spec.pdf", rules)).toBeNull();
    expect(pathRefusal("/opt/shared", rules)).toBeNull();
  });

  it("refuses a disk root, home and anything above home", () => {
    for (const path of ["/", "/Users", "/Users/alex"]) {
      expect(pathRefusal(path, rules)).not.toBeNull();
    }
  });

  it("refuses credentials, their insides and anything containing them", () => {
    for (const path of ["/Users/alex/.ssh", "/Users/alex/.ssh/id_ed25519", "/profile"]) {
      expect(pathRefusal(path, rules)).not.toBeNull();
    }
  });

  it.runIf(process.platform === "darwin")(
    "takes the data volume's spelling of a folder for the folder",
    () => {
      expect(
        touchesDenied("/private/tmp/project", ["/System/Volumes/Data/private/tmp/project/key"]),
      ).toBe(true);
      expect(
        touchesDenied("/System/Volumes/Data/Users/alex/project", ["/Users/alex/project/key"]),
      ).toBe(true);
    },
  );

  it("refuses a relative path", () => {
    expect(pathRefusal("Documents", rules)).not.toBeNull();
  });
});

describe("checkPathGrant", () => {
  it("refuses a link, naming where it leads, so what is granted is what was asked", async () => {
    const root = await directory();
    await mkdir(join(root, "real"));
    // A command could plant this in its workspace; the card would show the link, not the target.
    await symlink(join(root, "real"), join(root, "link"));
    const linked = await checkPathGrant(join(root, "link"), { home: "/nowhere", denied: [] });
    expect(linked.ok).toBe(false);
    const reason = linked.ok ? "" : linked.reason;
    expect(reason).toContain("real");
    expect(reason).toContain("Ask for that path itself.");

    const real = await checkPathGrant(join(root, "real") + "/", { home: "/nowhere", denied: [] });
    expect(real).toMatchObject({ ok: true });
  });

  it("refuses a path spelled in another case than its real one", async () => {
    const root = await directory();
    await mkdir(join(root, "Project"));
    const resolve = async () => join(root, "project");
    const checked = await checkPathGrant(
      join(root, "Project"),
      { home: "/nowhere", denied: [] },
      resolve,
    );
    expect(checked).toMatchObject({ ok: false });
    expect(checked.ok ? "" : checked.reason).toContain(join(root, "project"));
  });

  it.runIf(process.platform === "darwin")("accepts macOS's own /tmp and /var aliases", async () => {
    // tmpdir() is under /var/folders, which resolves to /private/var/folders.
    const root = await directory();
    expect((await checkPathGrant(root, { home: "/nowhere", denied: [] })).ok).toBe(true);
  });

  it("refuses the app's own data, inside or above it", () => {
    const appData = {
      home: "/Users/alex",
      denied: ["/Users/alex/Library/Application Support/neema"],
    };
    for (const path of [
      "/Users/alex/Library/Application Support/neema/workspaces/other-chat",
      "/Users/alex/Library/Application Support/neema/Cookies",
      "/Users/alex/Library/Application Support",
    ])
      expect(pathRefusal(path, appData)).toBe(
        "Credentials and the app’s own data are never shared with commands.",
      );
  });

  it("refuses a missing path, a relative one and a non-string", async () => {
    expect((await checkPathGrant("/definitely/not/here", rules)).ok).toBe(false);
    expect((await checkPathGrant("relative", rules)).ok).toBe(false);
    expect((await checkPathGrant(42, rules)).ok).toBe(false);
  });
});

describe("loadPathGrants", () => {
  it("makes each scope readable only where it applies", async () => {
    const grants = await loadPathGrants(await directory(), rules);
    await grants.add({ scope: "always" }, "/opt/always");
    await grants.add({ scope: "chat", chat }, "/opt/chat");
    await grants.add({ scope: "answer", answer }, "/opt/answer");
    expect(grants.applying(answer)).toEqual(["/opt/always", "/opt/chat", "/opt/answer"]);
    expect(grants.applying({ ...answer, attempt: "attempt-2" })).toEqual([
      "/opt/always",
      "/opt/chat",
    ]);
    expect(grants.applying({ ...chat, conversationId: "chat-b", attempt: "x" })).toEqual([
      "/opt/always",
    ]);
  });

  it("ends answers that stopped running and forgets a deleted chat", async () => {
    const grants = await loadPathGrants(await directory(), rules);
    await grants.add({ scope: "chat", chat }, "/opt/chat");
    await grants.add({ scope: "answer", answer }, "/opt/answer");
    grants.keepAnswers(chat.origin, []);
    expect(grants.applying(answer)).toEqual(["/opt/chat"]);
    await grants.forgetChat(chat);
    expect(grants.applying(answer)).toEqual([]);
  });

  it("keeps always and chat grants across a reload, never answer grants", async () => {
    const root = await directory();
    const grants = await loadPathGrants(root, rules);
    await grants.add({ scope: "always" }, "/opt/always");
    await grants.add({ scope: "chat", chat }, "/opt/chat");
    await grants.add({ scope: "answer", answer }, "/opt/answer");
    const reloaded = await loadPathGrants(root, rules);
    expect(reloaded.applying(answer)).toEqual(["/opt/always", "/opt/chat"]);
    expect(JSON.parse(await readFile(join(root, "path-grants.json"), "utf8"))).toEqual({
      always: ["/opt/always"],
      chats: { "https://chat.example chat-a": ["/opt/chat"] },
    });
  });

  it("holds a hand-edited file to the same rules", async () => {
    const root = await directory();
    await writeFile(
      join(root, "path-grants.json"),
      JSON.stringify({
        always: ["/", "/Users/alex", "/Users/alex/.ssh", "relative", "/opt/ok", 7],
        chats: { "https://chat.example chat-a": ["/Users"] },
      }),
    );
    const grants = await loadPathGrants(root, rules);
    expect(grants.applying(answer)).toEqual(["/opt/ok"]);
  });
});
