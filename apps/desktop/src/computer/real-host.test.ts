import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MACHINE_HELLO_HEADER, type MachineEvent, type ToolResult } from "@chat/desktop-rpc";
import { ComputerHost } from "./host.ts";
import { microsandbox } from "./hypervisor.ts";

/**
 * The whole machine side against a stand-in server and real VMs, opt-in like real-vm.test.ts:
 * set NEEMA_VM_IMAGE (and NEEMA_VM_INSECURE=1 for a local registry).
 */
const IMAGE = process.env.NEEMA_VM_IMAGE;
const CHAT = "0190f0aa-0000-7000-8000-00000000cafe";

describe.skipIf(!IMAGE)("a machine running calls the server sends", () => {
  let root: string;
  let host: ComputerHost;
  let origin: string;
  let server: ReturnType<typeof createServer>;
  let stream: ServerResponse | undefined;
  const hellos: unknown[] = [];
  const results = new Map<string, ToolResult>();
  const discarded: string[] = [];
  const reportedFolders: unknown[] = [];
  let folderReport: () => void = () => {};
  let discardedOne: () => void = () => {};
  const firstDiscard = new Promise<void>((resolve) => (discardedOne = resolve));
  const waiters = new Map<string, (result: ToolResult) => void>();
  const send = (event: MachineEvent) =>
    stream?.write(`event: machine\ndata: ${JSON.stringify(event)}\n\n`);
  const body = async (request: IncomingMessage) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    return JSON.parse(text) as unknown;
  };
  const call = (
    callId: string,
    name: string,
    args: Record<string, unknown>,
    extra: Partial<MachineEvent> = {},
  ) =>
    new Promise<ToolResult>((resolve) => {
      waiters.set(callId, resolve);
      send({
        type: "call",
        callId,
        conversationId: CHAT,
        name,
        args,
        deadlineAt: 600_000,
        sentAt: 0,
        ...extra,
      } as MachineEvent);
    });

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "real-host-")));
    const folder = join(root, "notes");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "todo.md"), "- ship it\n");
    server = createServer(async (request, response) => {
      const header = request.headers[MACHINE_HELLO_HEADER];
      if (typeof header === "string") hellos.push(JSON.parse(header));
      if (request.url === "/api/machine/events") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        stream = response;
        send({ type: "grants", grants: [] });
        return;
      }
      const result = /^\/api\/machine\/calls\/([^/]+)\/result$/.exec(request.url ?? "");
      if (result) {
        const answer = (await body(request)) as ToolResult;
        results.set(result[1]!, answer);
        waiters.get(result[1]!)?.(answer);
        response.end("{}");
        return;
      }
      if (request.url === "/api/machine/folders") {
        reportedFolders.push(await body(request));
        folderReport();
        response.end("{}");
        return;
      }
      if (request.url === "/api/machine/gone") {
        const { conversationIds } = (await body(request)) as { conversationIds: string[] };
        response.end(
          JSON.stringify({ conversationIds: conversationIds.filter((id) => id === "purged") }),
        );
        return;
      }
      if (request.url === "/api/files/att-1") {
        response.writeHead(200, { "content-disposition": 'attachment; filename="sales.csv"' });
        response.end("month,total\njan,3\n");
        return;
      }
      response.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    host = new ComputerHost({
      origin,
      directory: join(root, "computer"),
      image: IMAGE!,
      hypervisor: microsandbox(() => import("microsandbox"), {
        insecureRegistry: process.env.NEEMA_VM_INSECURE === "1",
      }),
      machine: { id: "machine-1", name: "Test Mac" },
      fetch: (url, init) => fetch(url, init),
      // Like main's `ensure`: a chat's first call finds no workspace folder yet.
      workspace: async () => {
        await mkdir(join(root, "workspace"), { recursive: true });
        return join(root, "workspace");
      },
      folders: async (conversationId) => {
        if (conversationId === "unreadable") throw new Error("the grants file is unreadable");
        return [{ name: "notes", hostPath: folder, readOnly: false }];
      },
      discardWorkspace: async (conversationId) => {
        discarded.push(conversationId);
        discardedOne();
      },
      localChats: async () => ["chat-1", "purged"],
      cloneWorkspace: async () => {},
      agentSocket: () => null,
      remote: () => true,
      ask: {
        folder: async ({ path }) =>
          path ? { hostPath: path } : { refused: "The user picked no folder." },
        agent: async () => true,
      },
      attach: async (_conversationId, hostPath) => ({ name: hostPath.split("/").pop()! }),
      log: () => {},
    });
    await host.start();
  }, 600_000);

  afterAll(async () => {
    await host?.stop();
    server?.close();
    await rm(root, { recursive: true, force: true });
  }, 120_000);

  test("the machine says it is ready once the image is here", () => {
    expect(hellos.at(-1)).toMatchObject({ machineId: "machine-1", computer: { status: "ready" } });
  });

  test("a call copies the chat's files first, then runs and answers", async () => {
    const answer = await call(
      "c1",
      "run_command",
      { command: "cat /workspace/sales.csv && cat /folders/notes/todo.md" },
      { attachments: [{ id: "att-1", path: "/workspace/sales.csv" }] } as Partial<MachineEvent>,
    );
    expect(answer).toMatchObject({ ok: true, summary: expect.stringMatching(/^Ran /) });
    expect(answer.detail).toContain("jan,3");
    expect(answer.detail).toContain("- ship it");
    expect(await readFile(join(root, "workspace", "sales.csv"), "utf8")).toContain("jan,3");
  }, 300_000);

  test("a sent file the model deleted stays deleted", async () => {
    const sent = { attachments: [{ id: "att-1", path: "/workspace/sales.csv" }] };
    await call("c1-rm", "run_command", { command: "rm /workspace/sales.csv" }, sent);
    const answer = await call(
      "c1-ls",
      "run_command",
      { command: "test -e /workspace/sales.csv && echo back || echo gone" },
      sent,
    );
    expect(answer.detail).toContain("gone");
  }, 120_000);

  test("a refused destination is named, with what to ask for", async () => {
    const answer = await call("c2", "run_command", {
      command: "curl -sS -m 5 https://example.com -o /dev/null",
    });
    expect(answer.ok).toBe(false);
    expect(answer.summary).toBe("Network access blocked: example.com:443");
    expect(answer.violations).toEqual(["example.com:443 needs request_network_access"]);
  }, 120_000);

  test("a grant pushed by the server opens the destination", async () => {
    send({
      type: "grants",
      grants: [
        { id: "g1", host: "example.com", port: 443, privateNetwork: false, conversationId: CHAT },
      ],
    });
    const answer = await call("c3", "run_command", {
      command: "curl -sS -m 10 -o /dev/null -w '%{http_code}' https://example.com",
    });
    expect(answer).toMatchObject({ ok: true });
    expect(answer.detail).toContain("200");
  }, 120_000);

  test("file tools answer in the model's words", async () => {
    const edit = await call("c4", "edit_local_file", {
      path: "/folders/notes/todo.md",
      old: "ship it",
      new: "shipped",
    });
    expect(edit).toMatchObject({ ok: true, summary: "Edited /folders/notes/todo.md" });
    const outside = await call("c5", "read_local_file", { path: "/etc/passwd" });
    expect(outside).toMatchObject({
      ok: false,
      summary: "That path is outside this chat's folders",
    });
  }, 120_000);

  test("asking for a folder or the agent needs no VM and answers in the model's words", async () => {
    expect(await call("c7", "request_folder", {})).toMatchObject({
      ok: false,
      detail: "The user picked no folder.",
    });
    expect(await call("c8", "request_folder", { path: "/tmp/reports" })).toMatchObject({
      ok: true,
      summary: "Attached /folders/reports",
    });
    expect(await call("c9", "request_ssh_agent", {})).toMatchObject({ ok: true });
  }, 60_000);

  test("a branch hears its folders from the machine once they are copied", async () => {
    const reported = new Promise<void>((resolve) => (folderReport = resolve));
    send({ type: "clone", from: CHAT, to: "branch-1" });
    await reported;
    expect(reportedFolders.at(-1)).toEqual({
      conversationId: "branch-1",
      folders: [{ name: "notes", readOnly: false }],
    });
  });

  test("a chat purged while the machine was offline is removed once it asks", async () => {
    await firstDiscard;
    expect(discarded).toEqual(["purged"]);
  });

  test("a call the server no longer waits on stops when the machine reconnects", async () => {
    const pending = call("c-unwanted", "run_command", { command: "sleep 120" });
    setTimeout(() => send({ type: "running", callIds: [] }), 1_500);
    const answer = await pending;
    expect(answer.ok).toBe(false);
    expect(answer.detail).toMatch(/stopped/);
  }, 120_000);

  test("time spent waiting behind the chat's earlier call counts against a command", async () => {
    const first = call("c-slow", "run_command", { command: "sleep 3" });
    // 17 s on arrival, 15 s of which are kept for the answer's trip back: gone after the wait.
    const second = call("c-late", "run_command", { command: "echo ran" }, {
      deadlineAt: 17_000,
      sentAt: 0,
    } as Partial<MachineEvent>);
    await first;
    expect(await second).toMatchObject({ ok: false, summary: "Not started" });
  }, 120_000);

  test("a call that cannot even start is still answered", async () => {
    const answer = await call("c-unreadable", "list_folder", { path: "." }, {
      conversationId: "unreadable",
    } as Partial<MachineEvent>);
    expect(answer).toMatchObject({ ok: false, summary: "The computer could not do that" });
    expect(answer.detail).toContain("unreadable");
  });

  test("a cancel stops the command it names", async () => {
    const pending = call("c6", "run_command", { command: "sleep 120" });
    setTimeout(() => send({ type: "cancel", callId: "c6" }), 1_500);
    const answer = await pending;
    expect(answer.ok).toBe(false);
    expect(answer.detail).toMatch(/stopped/);
  }, 120_000);
});
