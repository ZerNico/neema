import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, win32 } from "node:path";
import { AGENT_DESTINATION } from "./ssh-agent.ts";

/**
 * Opens an authenticated CONNECT through the egress proxy, reading the proxy,
 * token included, from the environment, so no file holds the token. Calls back
 * with the socket and any bytes past the response head, or with the refusal.
 */
const CONNECT = `"use strict";
const net = require("node:net");
const proxy = new URL(process.env.HTTPS_PROXY || process.env.https_proxy || "");
// A command's own port (Linux) takes no credentials.
const authorization = proxy.username
  ? "\\r\\nProxy-Authorization: Basic " +
    Buffer.from(
      decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password),
    ).toString("base64")
  : "";
function connectThrough(authority, opened, refused) {
  const socket = net.connect(Number(proxy.port), proxy.hostname, () => {
    socket.write(
      "CONNECT " + authority + " HTTP/1.1\\r\\nHost: " + authority + authorization + "\\r\\n\\r\\n",
    );
  });
  let head = Buffer.alloc(0);
  const answer = (chunk) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\\r\\n\\r\\n");
    if (end < 0) return;
    socket.off("data", answer);
    const status = head.subarray(0, end).toString("latin1").split("\\r\\n")[0];
    if (status.split(" ")[1] !== "200") return refused(status, socket);
    opened(socket, head.subarray(end + 4));
  };
  socket.on("data", answer);
  return socket;
}
`;

/**
 * The bridge ssh runs as its ProxyCommand: a CONNECT to the destination, then
 * bytes both ways. Run by the app's own executable in Node mode, so nothing has
 * to be installed.
 */
const TUNNEL = `${CONNECT}
const [host, port] = process.argv.slice(2);
const authority = (host.includes(":") ? "[" + host + "]" : host) + ":" + port;
const socket = connectThrough(
  authority,
  (socket, rest) => {
    if (rest.length > 0) process.stdout.write(rest);
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  },
  (status) => {
    process.stderr.write("Network access to " + authority + " was refused: " + status + "\\n");
    process.exit(1);
  },
);
socket.on("error", (error) => {
  process.stderr.write("SSH tunnel failed: " + error.message + "\\n");
  process.exit(1);
});
socket.on("close", () => process.exit(0));
`;

/**
 * Windows' agent is a named pipe no container may open, so ssh there starts
 * under this bridge: a pipe of the command's own, named to ssh as its agent,
 * whose every connection the proxy carries to the user's agent. The proxy
 * decides it like any destination, so only a chat that allowed it gets through.
 */
const AGENT_BRIDGE = `${CONNECT}
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const pipe = "\\\\\\\\.\\\\pipe\\\\neema-agent-" + randomBytes(12).toString("hex");
const server = net.createServer((client) => {
  const upstream = connectThrough(
    "${AGENT_DESTINATION.host}:${AGENT_DESTINATION.port}",
    (socket, rest) => {
      if (rest.length > 0) client.write(rest);
      client.pipe(socket);
      socket.pipe(client);
    },
    (status, socket) => {
      process.stderr.write("The SSH agent was refused: " + status + "\\n");
      socket.destroy();
      client.destroy();
    },
  );
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
});
server.on("error", (error) => {
  process.stderr.write("SSH agent bridge failed: " + error.message + "\\n");
  process.exit(255);
});
server.listen(pipe, () => {
  const [ssh, ...args] = process.argv.slice(2);
  const child = spawn(ssh, args, { stdio: "inherit", env: { ...process.env, SSH_AUTH_SOCK: pipe } });
  child.on("error", (error) => {
    process.stderr.write("ssh failed to start: " + error.message + "\\n");
    process.exit(255);
  });
  child.on("exit", (code) => process.exit(code ?? 255));
});
`;

const quoted = (value: string) => `"${value.replaceAll('"', '\\"')}"`;

/** The real ssh on the desktop's PATH, before the wrapper shadows it. */
export const findSsh = async (
  path: string | undefined,
  exists: (file: string) => Promise<boolean>,
  os: NodeJS.Platform = process.platform,
): Promise<string | null> => {
  const separator = os === "win32" ? ";" : delimiter;
  const file = os === "win32" ? "ssh.exe" : "ssh";
  const at = os === "win32" ? win32.join : join;
  for (const directory of (path ?? "").split(separator).filter(Boolean)) {
    const candidate = at(directory, file);
    if (await exists(candidate)) return candidate;
  }
  return null;
};

export interface SshSetup {
  /** Prepended to the command's PATH, so `ssh`, `git`, `scp` and `rsync` find the wrapper. */
  readonly bin: string;
  /** The wrapper itself, for git: Git for Windows runs its own ssh unless told otherwise. */
  readonly wrapper: string;
}

/**
 * Writes an `ssh` wrapper with its own config into a command's private
 * folder: the proxy bridge, no connection sharing (a master would outlive the
 * command's token), and known hosts from a copy of the user's, since
 * `~/.ssh` itself stays unreadable. No agent unless the chat allows it.
 */
export const writeSshSetup = async (input: {
  readonly os: NodeJS.Platform;
  readonly directory: string;
  readonly ssh: string;
  /** The app's own executable, run in Node mode for the bridge. */
  readonly node: string;
  readonly knownHosts: string | null;
  /** The user's agent socket, when the chat allows signing in with it. */
  readonly agent: string | null;
  /** Windows: the chat allows the agent, reached through the proxy rather than a path. */
  readonly relayAgent?: boolean;
}): Promise<SshSetup> => {
  const windows = input.os === "win32";
  // Windows OpenSSH reads forward slashes in its config without escaping rules.
  const configPath = (path: string) => quoted(windows ? path.replaceAll("\\", "/") : path);
  const bin = join(input.directory, "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const tunnel = join(input.directory, "ssh-tunnel.cjs");
  await writeFile(tunnel, TUNNEL, { mode: 0o600 });
  const known = join(input.directory, "known_hosts");
  if (input.knownHosts) await copyFile(input.knownHosts, known).catch(() => undefined);
  const config = join(input.directory, "ssh_config");
  await writeFile(
    config,
    [
      "Host *",
      // Windows has no env(1); its wrapper sets ELECTRON_RUN_AS_NODE for ssh and the bridge.
      windows
        ? `  ProxyCommand ${configPath(input.node)} ${configPath(tunnel)} %h %p`
        : `  ProxyCommand /usr/bin/env ELECTRON_RUN_AS_NODE=1 ${quoted(input.node)} ${quoted(tunnel)} %h %p`,
      "  ControlMaster no",
      "  ControlPath none",
      `  UserKnownHostsFile ${configPath(known)}`,
      "  StrictHostKeyChecking accept-new",
      // The bridge names its pipe to ssh in SSH_AUTH_SOCK.
      `  IdentityAgent ${input.relayAgent ? "SSH_AUTH_SOCK" : input.agent ? configPath(input.agent) : "none"}`,
      // Key files stay unreadable; trying them only prints a denial per file.
      "  IdentityFile none",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  if (windows) {
    const ssh = `${quoted(input.ssh)} -F ${quoted(config)} %*`;
    let start = ssh;
    if (input.relayAgent) {
      const bridge = join(input.directory, "ssh-agent-bridge.cjs");
      await writeFile(bridge, AGENT_BRIDGE);
      start = `${quoted(input.node)} ${quoted(bridge)} ${ssh}`;
    }
    // setlocal keeps the variable from outliving ssh in the command's own cmd session.
    const wrapper = join(bin, "ssh.cmd");
    await writeFile(
      wrapper,
      ["@setlocal", "@set ELECTRON_RUN_AS_NODE=1", `@${start}`, "@exit /b %ERRORLEVEL%", ""].join(
        "\r\n",
      ),
    );
    return { bin, wrapper };
  }
  const wrapper = join(bin, "ssh");
  await writeFile(wrapper, `#!/bin/sh\nexec ${quoted(input.ssh)} -F ${quoted(config)} "$@"\n`, {
    mode: 0o700,
  });
  await chmod(wrapper, 0o700);
  return { bin, wrapper };
};

/** The folder holding the app's executable that commands must be able to read. */
export const appBundle = (executable: string) => {
  const marker = executable.indexOf(".app/");
  return marker >= 0 ? executable.slice(0, marker + 4) : dirname(executable);
};
