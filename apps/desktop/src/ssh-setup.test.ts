import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appBundle, findSsh, userHostSettings, writeSshSetup } from "./ssh-setup.ts";

const roots: string[] = [];
const directory = async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-ssh-setup-"));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("findSsh", () => {
  it("takes the first ssh on the PATH that exists", async () => {
    const present = new Set(["/opt/b/ssh", "/usr/bin/ssh"]);
    expect(
      await findSsh("/opt/a:/opt/b:/usr/bin", async (file) => present.has(file), "darwin"),
    ).toBe("/opt/b/ssh");
    expect(await findSsh(undefined, async () => true, "darwin")).toBeNull();
  });

  it("looks for ssh.exe along a Windows PATH", async () => {
    const found = await findSsh(
      "C:\\Tools;C:\\Windows\\System32\\OpenSSH",
      async (file) => file === "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
      "win32",
    );
    expect(found).toBe("C:\\Windows\\System32\\OpenSSH\\ssh.exe");
  });
});

describe("appBundle", () => {
  it("is the .app bundle on macOS and the executable's folder elsewhere", () => {
    expect(appBundle("/Applications/neema.app/Contents/MacOS/neema")).toBe(
      "/Applications/neema.app",
    );
    expect(appBundle("/opt/neema/neema")).toBe("/opt/neema");
  });
});

describe("writeSshSetup", () => {
  it("never makes a command folder that is already gone", async () => {
    const gone = join(await directory(), "neema-command-gone");
    await expect(
      writeSshSetup({
        os: "darwin",
        directory: gone,
        ssh: "/usr/bin/ssh",
        node: "/opt/neema/neema",
        knownHosts: null,
        userConfig: null,
        relayAgent: false,
      }),
    ).rejects.toThrow("ENOENT");
    await expect(stat(gone)).rejects.toThrow("ENOENT");
  });

  it("writes a wrapper and a config that tunnel through the proxy and share nothing", async () => {
    const root = await directory();
    const knownHosts = join(root, "user_known_hosts");
    await writeFile(knownHosts, "github.com ssh-ed25519 AAAA\n");
    const setup = await writeSshSetup({
      os: "darwin",
      directory: root,
      ssh: "/usr/bin/ssh",
      node: "/Applications/neema.app/Contents/MacOS/neema",
      knownHosts,
      userConfig: null,
      relayAgent: false,
    });
    const config = await readFile(join(root, "ssh_config"), "utf8");
    expect(config).toContain(
      `ProxyCommand /usr/bin/env ELECTRON_RUN_AS_NODE=1 "/Applications/neema.app/Contents/MacOS/neema" "${join(root, "ssh-tunnel.cjs")}" %h %p`,
    );
    expect(config).toContain("ControlMaster no");
    expect(config).toContain("ControlPath none");
    expect(config).toContain("IdentityAgent none");
    expect(config).toContain("IdentityFile none");
    expect(await readFile(join(root, "known_hosts"), "utf8")).toContain("github.com");
    const wrapper = await readFile(join(setup.bin, "ssh"), "utf8");
    expect(wrapper).toBe(
      `#!/bin/sh\nexec "/usr/bin/ssh" "-F" "${join(root, "ssh_config")}" "$@"\n`,
    );
    expect(setup.wrapper).toBe(join(setup.bin, "ssh"));
    expect((await stat(join(setup.bin, "ssh"))).mode & 0o777).toBe(0o700);
    // The token never lands in a file.
    expect(await readFile(join(root, "ssh-tunnel.cjs"), "utf8")).toContain(
      "process.env.HTTPS_PROXY",
    );
  });

  it("writes a cmd wrapper on Windows that hands ELECTRON_RUN_AS_NODE to ssh alone", async () => {
    const root = await directory();
    const setup = await writeSshSetup({
      os: "win32",
      directory: root,
      ssh: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
      node: "C:\\Program Files\\neema\\neema.exe",
      knownHosts: null,
      userConfig: null,
      relayAgent: false,
    });
    expect(setup.wrapper.endsWith("ssh.cmd")).toBe(true);
    const wrapper = await readFile(setup.wrapper, "utf8");
    expect(wrapper.split("\r\n")).toEqual([
      "@setlocal",
      "@set ELECTRON_RUN_AS_NODE=1",
      `@"C:\\Windows\\System32\\OpenSSH\\ssh.exe" "-F" "${setup.bin.slice(0, -"bin".length)}ssh_config" %*`,
      "@exit /b %ERRORLEVEL%",
      "",
    ]);
    const config = await readFile(setup.wrapper.replace(/bin.ssh\.cmd$/, "ssh_config"), "utf8");
    expect(config).toContain(`ProxyCommand "C:/Program Files/neema/neema.exe" "`);
    expect(config).not.toContain("/usr/bin/env");
  });

  it("starts ssh under the agent bridge on Windows when the chat allows the agent", async () => {
    const root = await directory();
    const setup = await writeSshSetup({
      os: "win32",
      directory: root,
      ssh: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
      node: "C:\\Program Files\\neema\\neema.exe",
      knownHosts: null,
      userConfig: null,
      relayAgent: true,
    });
    const bridge = join(root, "ssh-agent-bridge.cjs");
    expect((await readFile(setup.wrapper, "utf8")).split("\r\n")[2]).toBe(
      `@"C:\\Program Files\\neema\\neema.exe" "${bridge}" "C:\\Windows\\System32\\OpenSSH\\ssh.exe" "-F" "${join(root, "ssh_config")}" %*`,
    );
    expect(await readFile(join(root, "ssh_config"), "utf8")).toContain(
      "IdentityAgent SSH_AUTH_SOCK",
    );
    const source = await readFile(bridge, "utf8");
    expect(source).toContain('"ssh-agent.invalid:1"');
    expect(source).toContain('"\\\\\\\\.\\\\pipe\\\\neema-agent-"');
    // The generated script must parse.
    const checked = spawnSync(process.execPath, ["--check", bridge], { encoding: "utf8" });
    expect(checked.stderr).toBe("");
    expect(checked.status).toBe(0);
  });

  it("starts ssh, ssh-add and ssh-keygen under the agent bridge, never naming its socket", async () => {
    const root = await directory();
    const tools = await directory();
    for (const name of ["ssh", "ssh-add", "ssh-keygen"]) await writeFile(join(tools, name), "");
    const setup = await writeSshSetup({
      os: "darwin",
      directory: root,
      ssh: join(tools, "ssh"),
      node: "/Applications/neema.app/Contents/MacOS/neema",
      knownHosts: null,
      userConfig: null,
      relayAgent: true,
    });
    const bridge = join(root, "ssh-agent-bridge.cjs");
    const run = `exec /usr/bin/env ELECTRON_RUN_AS_NODE=1 "/Applications/neema.app/Contents/MacOS/neema" "${bridge}"`;
    expect(await readFile(setup.wrapper, "utf8")).toBe(
      `#!/bin/sh\n${run} "${join(tools, "ssh")}" "-F" "${join(root, "ssh_config")}" "$@"\n`,
    );
    expect(setup.keygen).toBe(join(setup.bin, "ssh-keygen"));
    expect(await readFile(join(setup.bin, "ssh-keygen"), "utf8")).toBe(
      `#!/bin/sh\n${run} "${join(tools, "ssh-keygen")}" "$@"\n`,
    );
    expect(await readFile(join(setup.bin, "ssh-add"), "utf8")).toBe(
      `#!/bin/sh\n${run} "${join(tools, "ssh-add")}" "$@"\n`,
    );
    const config = await readFile(join(root, "ssh_config"), "utf8");
    expect(config).toContain("IdentityAgent SSH_AUTH_SOCK");
    const checked = spawnSync(process.execPath, ["--check", bridge], { encoding: "utf8" });
    expect(checked.status).toBe(0);
  });

  it("hands scp and sftp the wrapper, since they run ssh by its absolute path", async () => {
    const root = await directory();
    const tools = await directory();
    for (const name of ["ssh", "scp", "sftp"]) await writeFile(join(tools, name), "");
    const setup = await writeSshSetup({
      os: "linux",
      directory: root,
      ssh: join(tools, "ssh"),
      node: process.execPath,
      knownHosts: null,
      userConfig: null,
      relayAgent: false,
    });
    for (const name of ["scp", "sftp"])
      expect(await readFile(join(setup.bin, name), "utf8")).toBe(
        `#!/bin/sh\nexec "${join(tools, name)}" "-S" "${setup.wrapper}" "$@"\n`,
      );
    // Without the agent there is no ssh-add wrapper to reach it through.
    expect(await stat(join(setup.bin, "ssh-add")).catch(() => null)).toBeNull();
  });

  it("keeps the user's host aliases after the generated settings", async () => {
    const root = await directory();
    const userConfig = join(root, "user_config");
    await writeFile(
      userConfig,
      [
        "Host work-github",
        "  HostName github.com",
        "  User git",
        "  IdentityFile ~/.ssh/work",
        "  ProxyCommand nc %h %p",
        'Match exec "touch /tmp/x"',
        "  HostName evil.example",
        "Host db",
        "  Port=2222",
        "Include ~/.ssh/more",
      ].join("\n"),
    );
    await writeSshSetup({
      os: "darwin",
      directory: root,
      ssh: "/usr/bin/ssh",
      node: process.execPath,
      knownHosts: null,
      userConfig,
      relayAgent: false,
    });
    const config = await readFile(join(root, "ssh_config"), "utf8");
    const [generated = "", user = ""] = config.trimEnd().split("\n\n");
    expect(generated).toContain("ProxyCommand /usr/bin/env");
    expect(user).toBe("Host work-github\n  HostName github.com\n  User git\nHost db\n  Port 2222");
  });
});

describe("userHostSettings", () => {
  it("drops Match blocks, keys, proxies and includes", () => {
    expect(
      userHostSettings(
        "# comment\nHost a\n  IdentityAgent ~/x.sock\n  ProxyJump bastion\n  hostname A.example\nMatch host a\n  User root\n",
      ),
    ).toBe("Host a\n  hostname A.example");
  });
});

describe("the agent bridge", () => {
  it("names a socket of its own to the program and carries it through the proxy", async () => {
    const proxy = await fakeProxy("200 Connection Established");
    // Socket paths are limited to 104 bytes on macOS; command folders sit in a short root too.
    const root = await realpath(await mkdtemp("/tmp/chat-bridge-"));
    roots.push(root);
    await writeSshSetup({
      os: "darwin",
      directory: root,
      ssh: "/usr/bin/ssh",
      node: process.execPath,
      knownHosts: null,
      userConfig: null,
      relayAgent: true,
    });
    // Stands in for ssh-add: talks to whatever SSH_AUTH_SOCK names and prints the answer.
    const client = join(root, "client.cjs");
    await writeFile(
      client,
      `const s = require("node:net").connect(process.env.SSH_AUTH_SOCK, () => s.write("ping"));
       s.once("data", (d) => { console.log(process.env.SSH_AUTH_SOCK.startsWith(${JSON.stringify(root)}), String(d)); s.destroy(); });`,
    );
    const child = spawn(
      process.execPath,
      [join(root, "ssh-agent-bridge.cjs"), process.execPath, client],
      { env: { HTTPS_PROXY: `http://cmd:secret-token@127.0.0.1:${proxy.port}` } },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(Buffer.concat(stderr).toString()).toBe("");
    expect(code).toBe(0);
    // The fake proxy echoes, so the program's request comes back through the bridge.
    expect(Buffer.concat(stdout).toString().trim()).toBe("true ping");
    expect(proxy.heads[0]).toContain("CONNECT ssh-agent.invalid:1 HTTP/1.1");
    await proxy.close();
  });

  it("closes the program's agent connection when the proxy hangs up before answering", async () => {
    const server = createServer((socket: Socket) => socket.once("data", () => socket.destroy()));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const root = await realpath(await mkdtemp("/tmp/chat-bridge-"));
    roots.push(root);
    await writeSshSetup({
      os: "darwin",
      directory: root,
      ssh: "/usr/bin/ssh",
      node: process.execPath,
      knownHosts: null,
      userConfig: null,
      relayAgent: true,
    });
    const client = join(root, "client.cjs");
    await writeFile(
      client,
      `const s = require("node:net").connect(process.env.SSH_AUTH_SOCK, () => s.write("ping"));
       s.on("close", () => console.log("closed"));`,
    );
    const child = spawn(
      process.execPath,
      [join(root, "ssh-agent-bridge.cjs"), process.execPath, client],
      { env: { HTTPS_PROXY: `http://cmd:secret-token@127.0.0.1:${port}` } },
    );
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    await new Promise((resolve) => child.on("close", resolve));
    expect(Buffer.concat(stdout).toString().trim()).toBe("closed");
    await new Promise((resolve) => server.close(resolve));
  });
});

/** A stand-in proxy: records the CONNECT, answers with `status`, then echoes. */
const fakeProxy = async (status: string) => {
  const heads: string[] = [];
  const server = createServer((socket: Socket) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      heads.push(buffered.subarray(0, end).toString("latin1"));
      socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
      if (!status.startsWith("200")) return socket.end();
      const rest = buffered.subarray(end + 4);
      if (rest.length > 0) socket.write(rest);
      socket.pipe(socket);
    };
    socket.on("data", onData);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    heads,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const runTunnel = async (proxyPort: number, input: string) => {
  const root = await directory();
  await writeSshSetup({
    os: "darwin",
    directory: root,
    ssh: "/usr/bin/ssh",
    node: process.execPath,
    knownHosts: null,
    userConfig: null,
    relayAgent: false,
  });
  const child = spawn(process.execPath, [join(root, "ssh-tunnel.cjs"), "github.com", "22"], {
    env: { HTTPS_PROXY: `http://cmd:secret-token@127.0.0.1:${proxyPort}` },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(input);
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return {
    code,
    stdout: Buffer.concat(stdout).toString(),
    stderr: Buffer.concat(stderr).toString(),
  };
};

describe("the tunnel", () => {
  it("connects with the command's credentials and relays both ways", async () => {
    const proxy = await fakeProxy("200 Connection Established");
    const result = await runTunnel(proxy.port, "SSH-2.0-test\r\n");
    expect(result.stdout).toBe("SSH-2.0-test\r\n");
    expect(proxy.heads[0]).toContain("CONNECT github.com:22 HTTP/1.1");
    expect(proxy.heads[0]).toContain(
      `Proxy-Authorization: Basic ${Buffer.from("cmd:secret-token").toString("base64")}`,
    );
    await proxy.close();
  });

  it("exits with the refusal when the proxy denies the destination", async () => {
    const proxy = await fakeProxy("403 Forbidden");
    const result = await runTunnel(proxy.port, "");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Network access to github.com:22 was refused");
    expect(result.stderr).not.toContain("secret-token");
    await proxy.close();
  });
});
