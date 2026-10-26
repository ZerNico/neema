import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDesktopResponder, type DesktopHandlers } from "@chat/desktop-rpc";
import { ComputerSettings } from "./computer-settings.ts";
import { GrantStore } from "./grants.ts";
import { makeHandlers, type Shell } from "./handlers.ts";
import { WorkspaceRegistry } from "./workspaces.ts";

/**
 * The handlers are the layer the remote page actually reaches, so containment is asserted here
 * against real directories and real links. The page names guest paths, `/workspace/...` and
 * `/folders/<name>/...`; the chat's computer writes in both and can plant links.
 */
const CONVERSATION = "01990f4e-6650-7a33-a768-611e2e4bf4c7";
const OTHER = "01990f4e-6650-7a33-a768-611e2e4bf4c8";

let base: string;
let site: string;
let outside: string;
let workspaces: string;
let handlers: DesktopHandlers;
let picked: string | null;
let revealed: { absolute: string; mode: string }[];
let revealComplaint: string | null;
let remoteChanges: number;

const failureOf = async <A>(effect: Effect.Effect<A, { reason: string }>) => {
  const outcome = await Effect.runPromise(Effect.result(effect));
  return outcome._tag === "Failure" ? outcome.failure.reason : "unexpected success";
};

const attach = async (folder: string, readOnly?: boolean) => {
  picked = folder;
  return Effect.runPromise(
    handlers.chooseFolder({ conversationId: CONVERSATION, ...(readOnly ? { readOnly } : {}) }),
  );
};

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "chat-handlers-")));
  site = join(base, "site");
  outside = join(base, "elsewhere");
  workspaces = join(base, "workspaces");
  await mkdir(join(site, "src"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(site, "src", "index.ts"), "export {}\n");
  await writeFile(join(outside, "secrets.txt"), "token\n");
  // What a guest can do inside a mount: links that lead off it.
  await symlink(outside, join(site, "escape"));
  await symlink(join(outside, "secrets.txt"), join(site, "leak.txt"));
  await symlink(join(base, "missing"), join(site, "dangling"));

  const shell: Shell = {
    pickDirectory: async () => picked,
    revealPath: async (absolute, mode) => {
      revealed.push({ absolute, mode });
      return revealComplaint;
    },
    serverOrigin: () => "https://chat.test",
    appData: join(base, "app-data"),
    executionSession: () => ({ id: "session", machineId: "machine-1", machineName: "Test Mac" }),
    cancelCall: () => false,
    setWorkState: () => {},
    computer: () => ({ status: "preparing", progress: 0.25 }),
    settings: await ComputerSettings.load(join(base, "computer-settings.json")),
    remoteChanged: () => {
      remoteChanges += 1;
    },
  };
  await mkdir(shell.appData, { recursive: true });

  handlers = await Effect.runPromise(
    makeHandlers(shell).pipe(
      Effect.provide(
        Layer.mergeAll(GrantStore.layerEphemeral, WorkspaceRegistry.layerEphemeral(workspaces)),
      ),
    ),
  );
  await attach(site);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

beforeEach(() => {
  revealed = [];
  revealComplaint = null;
  remoteChanges = 0;
});

describe("folders", () => {
  it("reports folders by name and guest path, never where they live here", async () => {
    const status = await Effect.runPromise(handlers.folderStatus({ conversationId: CONVERSATION }));
    expect(status).toEqual({
      folders: [{ name: "site", path: "/folders/site", alive: true, readOnly: false }],
      workspace: { path: "/workspace" },
    });
    expect(JSON.stringify(status)).not.toContain(base);
  });

  it("attaches a folder read-only when asked, and detaches it by name", async () => {
    const docs = join(base, "docs");
    await mkdir(docs);
    const status = await attach(docs, true);
    expect(status.folders.find((folder) => folder.name === "docs")).toMatchObject({
      path: "/folders/docs",
      readOnly: true,
    });
    const after = await Effect.runPromise(
      handlers.detachFolder({ conversationId: CONVERSATION, name: "docs" }),
    );
    expect(after.folders.map((folder) => folder.name)).toEqual(["site"]);
  });

  it("refuses what no chat may have, a clash of names and the workspace's name", async () => {
    picked = join(base, "app-data");
    expect(await failureOf(handlers.chooseFolder({ conversationId: CONVERSATION }))).toBe("failed");
    const twin = join(base, "other", "site");
    await mkdir(twin, { recursive: true });
    picked = twin;
    expect(await failureOf(handlers.chooseFolder({ conversationId: CONVERSATION }))).toBe(
      "already-exists",
    );
    const named = join(base, "other", "workspace");
    await mkdir(named);
    picked = named;
    expect(await failureOf(handlers.chooseFolder({ conversationId: CONVERSATION }))).toBe(
      "already-exists",
    );
    // Cancelling the picker is an answer, not a fault.
    picked = null;
    const status = await Effect.runPromise(handlers.chooseFolder({ conversationId: CONVERSATION }));
    expect(status.folders.map((folder) => folder.name)).toEqual(["site"]);
  });

  it("reports a folder a link replaced as gone and stops reading it", async () => {
    const moved = join(base, "moved");
    await mkdir(moved);
    await writeFile(join(moved, "a.txt"), "a");
    picked = moved;
    await Effect.runPromise(handlers.chooseFolder({ conversationId: OTHER }));
    await rm(moved, { recursive: true });
    await symlink(outside, moved);
    const status = await Effect.runPromise(handlers.folderStatus({ conversationId: OTHER }));
    expect(status.folders).toEqual([
      { name: "moved", path: "/folders/moved", alive: false, readOnly: false },
    ]);
    expect(
      await failureOf(
        handlers.readFile({ conversationId: OTHER, path: "/folders/moved/secrets.txt" }),
      ),
    ).toBe("no-folder");
  });
});

describe("previews by guest path", () => {
  it("reads a folder's file and the workspace's", async () => {
    const file = await Effect.runPromise(
      handlers.readFile({ conversationId: CONVERSATION, path: "/folders/site/src/index.ts" }),
    );
    expect(file).toEqual({
      path: "/folders/site/src/index.ts",
      text: "export {}\n",
      truncated: false,
    });
    await mkdir(join(workspaces, CONVERSATION), { recursive: true });
    await writeFile(join(workspaces, CONVERSATION, "notes.md"), "# Notes\n");
    expect(
      await Effect.runPromise(
        handlers.fileInfo({ conversationId: CONVERSATION, path: "/workspace/./notes.md" }),
      ),
    ).toEqual({ path: "/workspace/notes.md", bytes: 8 });
  });

  it("refuses links the computer planted, traversal and paths under no root", async () => {
    for (const path of [
      "/folders/site/escape/secrets.txt",
      "/folders/site/leak.txt",
      "/folders/site/../site/escape/secrets.txt",
    ])
      expect(await failureOf(handlers.readFile({ conversationId: CONVERSATION, path }))).toBe(
        "outside-folder",
      );
    for (const path of [
      "/folders/site/../../etc/passwd",
      "/etc/passwd",
      "folders/site/src",
      "/folders/nope/a",
    ])
      expect(await failureOf(handlers.readFile({ conversationId: CONVERSATION, path }))).toBe(
        "outside-folder",
      );
    expect(
      await failureOf(
        handlers.readFile({ conversationId: CONVERSATION, path: "/folders/site/dangling" }),
      ),
    ).toBe("not-found");
    // Another chat has no folders, whatever this one attached.
    expect(
      await failureOf(
        handlers.readFile({ conversationId: OTHER, path: "/folders/site/src/index.ts" }),
      ),
    ).toBe("outside-folder");
  });

  it("refuses to read a binary file as text, and reads only pictures and PDFs as bytes", async () => {
    await writeFile(join(site, "blob.bin"), Buffer.from([1, 0, 2]));
    expect(
      await failureOf(
        handlers.readFile({ conversationId: CONVERSATION, path: "/folders/site/blob.bin" }),
      ),
    ).toBe("not-text");
    expect(
      await failureOf(
        handlers.readBinary({ conversationId: CONVERSATION, path: "/folders/site/blob.bin" }),
      ),
    ).toBe("not-binary");
    await writeFile(join(site, "dot.png"), Buffer.from([137, 80, 78, 71]));
    expect(
      await Effect.runPromise(
        handlers.readBinary({ conversationId: CONVERSATION, path: "/folders/site/dot.png" }),
      ),
    ).toEqual({
      path: "/folders/site/dot.png",
      mediaType: "image/png",
      base64: Buffer.from([137, 80, 78, 71]).toString("base64"),
      bytes: 4,
    });
    expect(
      await failureOf(
        handlers.fileInfo({ conversationId: CONVERSATION, path: "/folders/site/src" }),
      ),
    ).toBe("not-a-file");
  });
});

describe("revealing a file", () => {
  it("hands the file manager the real path a guest path stands for, never one outside", async () => {
    await Effect.runPromise(
      handlers.revealPath({
        conversationId: CONVERSATION,
        path: "/folders/site/src/index.ts",
        mode: "reveal",
      }),
    );
    expect(revealed).toEqual([{ absolute: join(site, "src", "index.ts"), mode: "reveal" }]);
    expect(
      await failureOf(
        handlers.revealPath({
          conversationId: CONVERSATION,
          path: "/folders/site/escape/secrets.txt",
          mode: "open",
        }),
      ),
    ).toBe("outside-folder");
    expect(revealed).toHaveLength(1);
  });

  it("opens only a kind of file its default application displays", async () => {
    await writeFile(join(site, "install.command"), "rm -rf /\n");
    await writeFile(join(site, "notes.txt"), "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(join(site, "photo.PNG"), "png");
    for (const name of ["install.command", "notes.txt"])
      expect(
        await failureOf(
          handlers.revealPath({
            conversationId: CONVERSATION,
            path: `/folders/site/${name}`,
            mode: "open",
          }),
        ),
      ).toBe("not-openable");
    await Effect.runPromise(
      handlers.revealPath({
        conversationId: CONVERSATION,
        path: "/folders/site/photo.PNG",
        mode: "open",
      }),
    );
    expect(revealed).toEqual([{ absolute: join(site, "photo.PNG"), mode: "open" }]);
    revealComplaint = "no application knows this file";
    expect(
      await failureOf(
        handlers.revealPath({
          conversationId: CONVERSATION,
          path: "/folders/site/photo.PNG",
          mode: "open",
        }),
      ),
    ).toBe("failed");
  });

  it("refuses an unknown mode at the bridge", async () => {
    const respond = makeDesktopResponder(handlers);
    expect(
      await Effect.runPromise(
        respond("revealPath", {
          conversationId: CONVERSATION,
          path: "/folders/site/src/index.ts",
          mode: "launch",
        }),
      ),
    ).toMatchObject({ ok: false, error: { reason: "failed" } });
    expect(revealed).toEqual([]);
  });
});

describe("saving to the workspace", () => {
  it("lands a file under a new name and names it by its guest path", async () => {
    const save = () =>
      Effect.runPromise(
        handlers.saveToWorkspace({
          conversationId: CONVERSATION,
          callId: "call",
          fileName: "../page.pdf",
          base64: Buffer.from("%PDF").toString("base64"),
        }),
      );
    expect(await save()).toEqual({ path: "/workspace/page.pdf", created: true, bytes: 4 });
    expect(await save()).toEqual({ path: "/workspace/page-1.pdf", created: true, bytes: 4 });
    expect(await readFile(join(workspaces, CONVERSATION, "page.pdf"), "utf8")).toBe("%PDF");
  });
});

describe("this computer's settings", () => {
  it("reports the computer's status with remote control on by default", async () => {
    expect(await Effect.runPromise(handlers.computerStatus(undefined))).toEqual({
      status: "preparing",
      progress: 0.25,
      remote: true,
      agentSocket: null,
    });
  });

  it("switches remote control, keeps it, and tells the server", async () => {
    expect(await Effect.runPromise(handlers.setRemoteControl({ enabled: false }))).toMatchObject({
      remote: false,
    });
    expect(remoteChanges).toBe(1);
    const saved = await ComputerSettings.load(join(base, "computer-settings.json"));
    expect(saved.get().remote).toBe(false);
    await Effect.runPromise(handlers.setRemoteControl({ enabled: true }));
  });

  it("takes an agent socket only by a full path to a socket, and clears it", async () => {
    expect(await failureOf(handlers.setAgentSocket({ path: "agent.sock" }))).toBe("failed");
    if (process.platform !== "win32")
      expect(
        await failureOf(handlers.setAgentSocket({ path: join(site, "src", "index.ts") })),
      ).toBe("failed");
    expect(await Effect.runPromise(handlers.setAgentSocket({ path: null }))).toMatchObject({
      agentSocket: null,
    });
  });
});
