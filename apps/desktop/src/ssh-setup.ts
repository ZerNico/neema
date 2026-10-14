import { chmod, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
// A command's own port (Linux) carries no credentials in its URL. Its token sits in this
// private folder instead, and proves the command where the port alone does not (the agent).
const key = (() => {
  try {
    return require("node:fs").readFileSync(require("node:path").join(__dirname, "proxy.key"), "utf8");
  } catch {
    return "";
  }
})();
const credentials = proxy.username
  ? decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)
  : key
    ? "cmd:" + key
    : "";
const authorization = credentials
  ? "\\r\\nProxy-Authorization: Basic " + Buffer.from(credentials).toString("base64")
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
 * The agent is never named to a container: ssh and ssh-add start under this
 * bridge, which listens on a socket (a pipe on Windows) of the command's own,
 * names it to them as their agent, and has the proxy carry each connection to
 * the user's agent. The proxy decides it like any destination, so only a chat
 * that allowed it gets through, and the agent's socket stays out of reach.
 */
const AGENT_BRIDGE = `${CONNECT}
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
// Socket paths are capped near 104 bytes; command folders sit in a short root to leave room.
const id = randomBytes(8).toString("hex");
const pipe =
  process.platform === "win32"
    ? "\\\\\\\\.\\\\pipe\\\\neema-agent-" + id
    : require("node:path").join(__dirname, "agent-" + id + ".sock");
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
  // The proxy may close before it answers (a revoked token); the program must not wait on it.
  upstream.on("error", () => client.destroy());
  upstream.on("close", () => client.destroy());
  client.on("error", () => upstream.destroy());
  client.on("close", () => upstream.destroy());
});
server.on("error", (error) => {
  process.stderr.write("SSH agent bridge failed: " + error.message + "\\n");
  process.exit(255);
});
server.listen(pipe, () => {
  const [program, ...args] = process.argv.slice(2);
  const child = spawn(program, args, {
    stdio: "inherit",
    env: { ...process.env, SSH_AUTH_SOCK: pipe },
  });
  child.on("error", (error) => {
    process.stderr.write(program + " failed to start: " + error.message + "\\n");
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
  /** Prepended to the command's PATH, so `ssh`, `git`, `scp` and `rsync` find the wrappers. */
  readonly bin: string;
  /** The ssh wrapper itself, for git: Git for Windows runs its own ssh unless told otherwise. */
  readonly wrapper: string;
  /** The ssh-keygen wrapper when the agent is relayed, for git's commit signing. */
  readonly keygen: string | null;
}

/** Settings that say how to reach a host, never how to authenticate or route around the proxy. */
const HOST_SETTINGS = new Set([
  "hostname",
  "user",
  "port",
  "hostkeyalias",
  "addressfamily",
  "connecttimeout",
  "connectionattempts",
  "serveraliveinterval",
  "serveralivecountmax",
  "tcpkeepalive",
  "compression",
  "ciphers",
  "macs",
  "kexalgorithms",
  "hostkeyalgorithms",
  "pubkeyacceptedalgorithms",
  "pubkeyacceptedkeytypes",
  "preferredauthentications",
  "requesttty",
  "loglevel",
]);

/**
 * The user's own `Host` blocks reduced to how to reach each host (aliases,
 * users, ports), so `git@work-github:org/repo` still resolves. Keys files,
 * agents, proxies, includes and `Match` blocks (which can run commands) are
 * dropped; the generated settings come first, and ssh keeps the first value.
 */
export const userHostSettings = (config: string) => {
  const lines: string[] = [];
  let inHost = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [, keyword = "", value = ""] = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line) ?? [];
    const key = keyword.toLowerCase();
    if (key === "host") {
      inHost = value.length > 0;
      if (inHost) lines.push(`Host ${value}`);
    } else if (key === "match") inHost = false;
    else if (inHost && HOST_SETTINGS.has(key) && value) lines.push(`  ${keyword} ${value}`);
  }
  return lines.join("\n");
};

const readText = (path: string | null) =>
  path ? readFile(path, "utf8").catch(() => "") : Promise.resolve("");

/**
 * Writes `ssh` (and `scp`, `sftp`, and with the agent `ssh-add`) wrappers with
 * their own config into a command's private folder: the proxy bridge, no
 * connection sharing (a master would outlive the command's token), known hosts
 * and host settings copied from the user's, since `~/.ssh` itself stays
 * unreadable, and the agent only through the bridge when the chat allows it.
 */
export const writeSshSetup = async (input: {
  readonly os: NodeJS.Platform;
  readonly directory: string;
  readonly ssh: string;
  /** The app's own executable, run in Node mode for the bridges. */
  readonly node: string;
  readonly knownHosts: string | null;
  /** The user's ssh config, for its host aliases. */
  readonly userConfig: string | null;
  /** The chat allows signing in with the user's agent, reached through the proxy. */
  readonly relayAgent: boolean;
  /** The command's token, when its proxy URL carries none (a command's own port). */
  readonly proxyKey?: string | null;
}): Promise<SshSetup> => {
  const windows = input.os === "win32";
  // Windows OpenSSH reads forward slashes in its config without escaping rules.
  const configPath = (path: string) => quoted(windows ? path.replaceAll("\\", "/") : path);
  const bin = join(input.directory, "bin");
  // Not recursive: a command folder removed by a Stop must stay gone, not be made again here.
  await mkdir(bin, { mode: 0o700 });
  const tunnel = join(input.directory, "ssh-tunnel.cjs");
  await writeFile(tunnel, TUNNEL, { mode: 0o600 });
  const bridge = join(input.directory, "ssh-agent-bridge.cjs");
  if (input.relayAgent) await writeFile(bridge, AGENT_BRIDGE, { mode: 0o600 });
  if (input.proxyKey)
    await writeFile(join(input.directory, "proxy.key"), input.proxyKey, { mode: 0o600 });
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
      // The bridge names its socket to ssh in SSH_AUTH_SOCK.
      `  IdentityAgent ${input.relayAgent ? "SSH_AUTH_SOCK" : "none"}`,
      // Key files stay unreadable; trying them only prints a denial per file.
      "  IdentityFile none",
      "",
      userHostSettings(await readText(input.userConfig)),
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const tools = dirname(input.ssh);
  const exe = windows ? ".exe" : "";
  const present = async (name: string) => {
    const path = join(tools, `${name}${exe}`);
    return (await stat(path).then(
      () => true,
      () => false,
    ))
      ? path
      : null;
  };
  /** A wrapper running `program` with `args`, under the agent bridge when the chat allows it. */
  const wrap = async (name: string, program: string, args: string[]) => {
    const start = input.relayAgent ? [input.node, bridge, program, ...args] : [program, ...args];
    if (windows) {
      const wrapper = join(bin, `${name}.cmd`);
      // setlocal keeps the variable from outliving the tool in the command's own cmd session.
      await writeFile(
        wrapper,
        [
          "@setlocal",
          "@set ELECTRON_RUN_AS_NODE=1",
          `@${start.map(quoted).join(" ")} %*`,
          "@exit /b %ERRORLEVEL%",
          "",
        ].join("\r\n"),
      );
      return wrapper;
    }
    const wrapper = join(bin, name);
    const env = input.relayAgent ? "/usr/bin/env ELECTRON_RUN_AS_NODE=1 " : "";
    await writeFile(wrapper, `#!/bin/sh\nexec ${env}${start.map(quoted).join(" ")} "$@"\n`, {
      mode: 0o700,
    });
    await chmod(wrapper, 0o700);
    return wrapper;
  };

  const wrapper = await wrap("ssh", input.ssh, ["-F", config]);
  // scp and sftp run ssh by its absolute path, not from PATH; -S hands them the wrapper.
  for (const name of ["scp", "sftp"]) {
    const program = await present(name);
    if (program) await wrap(name, program, ["-S", wrapper]);
  }
  // The agent's other users: listing keys, and git signing commits with an SSH key.
  let keygen: string | null = null;
  if (input.relayAgent) {
    const add = await present("ssh-add");
    if (add) await wrap("ssh-add", add, []);
    const signer = await present("ssh-keygen");
    if (signer) keygen = await wrap("ssh-keygen", signer, []);
  }
  return { bin, wrapper, keygen };
};

/** The folder holding the app's executable that commands must be able to read. */
export const appBundle = (executable: string) => {
  const marker = executable.indexOf(".app/");
  return marker >= 0 ? executable.slice(0, marker + 4) : dirname(executable);
};
