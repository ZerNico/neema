import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { commandWithEnvironment, forSandboxedChild } from "./sandbox-environment.ts";

const exec = promisify(execFile);
const readEnvironment = "\"$NEEMA_TEST_NODE\" -p 'JSON.stringify(process.env)'";
const childEnvironment = async (command: string, env = {}) => {
  const { stdout } = await exec("/bin/sh", ["-c", command], {
    env: { NEEMA_TEST_NODE: process.execPath, ...env },
  });
  return JSON.parse(stdout);
};

const suffix =
  "/usr/bin/sandbox-exec -p '(version 1) (allow network-outbound (remote ip \"localhost:3128\"))' " +
  "/bin/bash -c 'HTTPS_PROXY=http://localhost:8000 curl http://localhost:8080; printf \"PIP_CACHE_DIR=mine\"'";
const script =
  "env SANDBOX_RUNTIME=1 NO_PROXY=localhost,127.0.0.1 HTTPS_PROXY=http://srt.cDE%3D:tok@localhost:3128 " +
  "HTTP_PROXY=http://localhost:3128 ftp_proxy=socks5h://srt:tok@localhost:3128 " +
  "CLOUDSDK_PROXY_ADDRESS=localhost RSYNC_PROXY=localhost:3128 " +
  suffix;

describe("macOS proxy assignments", () => {
  it("points proxy variables at numeric loopback without touching the executable suffix", () => {
    const out = forSandboxedChild(["/bin/bash", "-c", script], "/tmp/work", "darwin")[2]!;
    expect(out).toContain("HTTPS_PROXY=http://srt.cDE%3D:tok@127.0.0.1:3128");
    expect(out).toContain("HTTP_PROXY=http://127.0.0.1:3128");
    expect(out).toContain("ftp_proxy=socks5h://srt:tok@127.0.0.1:3128");
    expect(out).toContain("CLOUDSDK_PROXY_ADDRESS=127.0.0.1");
    expect(out).toContain("RSYNC_PROXY=127.0.0.1:3128");
    expect(out).toContain("NO_PROXY=localhost,127.0.0.1");
    expect(out.endsWith(suffix)).toBe(true);
  });

  it("reads whole-quoted assignments past env unset options and unrelated quoted words", () => {
    const prefix = "env -u HTTP_PROXY -u 'https_proxy' 'OTHER=has spaces' ";
    const proxy = "'HTTPS_PROXY=http://fake%3D:fake@localhost:12345'";
    const out = forSandboxedChild(
      ["bash", "-c", prefix + proxy + " " + suffix],
      "/tmp",
      "darwin",
    )[2]!;
    expect(out).toBe(prefix + "'HTTPS_PROXY=http://fake%3D:fake@127.0.0.1:12345' " + suffix);
  });

  it.each([
    "HTTP_PROXY=http://localhost.example:80",
    "HTTPS_PROXY=http://localhost:token@example.com:443",
    "ALL_PROXY=http://127.0.0.1:80",
    "NO_PROXY=localhost,example.com",
    "no_proxy=localhost",
    "OTHER=http://localhost:80",
    "PIP_CACHE_DIR='/a cache'",
  ])("preserves unrelated values: %s", (assignment) => {
    const argv = ["bash", "-c", `env ${assignment} ${suffix}`];
    expect(forSandboxedChild(argv, "/tmp", "darwin")).toEqual(argv);
  });

  it.each([
    "echo localhost",
    'env HTTPS_PROXY="$PROXY" true',
    "env HTTPS_PROXY='unterminated",
    "env -u",
    "env -u HTTP_PROXY",
    "env ",
  ])("does not evaluate or repair nonliteral input: %s", (command) => {
    const argv = ["bash", "-c", command];
    expect(forSandboxedChild(argv, "/tmp", "darwin")).toEqual(argv);
  });

  it("leaves Linux proxy routing unchanged", () => {
    const argv = ["/bin/bash", "-c", script];
    expect(forSandboxedChild(argv, "/tmp", "linux")).toEqual(argv);
  });
});

describe.skipIf(process.platform === "win32")("literal shell execution", () => {
  it.each([
    "'HTTPS_PROXY=http://fake%3D:token@localhost:3128'",
    "HTTPS_PROXY='http://fake%3D:token@localhost:3128'",
    'HTTPS_PROXY="http://fake%3D:token@localhost:3128"',
    "HTTPS_PROXY=http://fake%3D:token@local'host':3128",
    "HTTPS_PROXY=http://fake%3D:token@local\\host:3128",
  ])("preserves credentials after decoding %s", async (assignment) => {
    const out = forSandboxedChild(
      ["bash", "-c", `env ${assignment} ${readEnvironment}`],
      "/tmp",
      "darwin",
    )[2]!;
    expect(await childEnvironment(out)).toMatchObject({
      HTTPS_PROXY: "http://fake%3D:token@127.0.0.1:3128",
    });
  });

  it("handles SRT apostrophe quoting and preserves spaces in unrelated assignments", async () => {
    const command = `env 'OTHER=has spaces and '"'"'quotes' 'HTTPS_PROXY=http://fake:it'"'"'s@localhost:3128' ${readEnvironment}`;
    const out = forSandboxedChild(["bash", "-c", command], "/tmp", "darwin")[2]!;
    expect(await childEnvironment(out)).toMatchObject({
      OTHER: "has spaces and 'quotes",
      HTTPS_PROXY: "http://fake:it's@127.0.0.1:3128",
    });
  });

  it("covers every generated proxy family", async () => {
    const keys = [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "http_proxy",
      "https_proxy",
      "ALL_PROXY",
      "all_proxy",
      "FTP_PROXY",
      "ftp_proxy",
      "GRPC_PROXY",
      "grpc_proxy",
      "DOCKER_HTTP_PROXY",
      "DOCKER_HTTPS_PROXY",
    ];
    const assignments = keys.map((key) => `'${key}=http://fake%3D:token@localhost:3128'`).join(" ");
    const out = forSandboxedChild(
      ["bash", "-c", `env ${assignments} ${readEnvironment}`],
      "/tmp",
      "darwin",
    )[2]!;
    const env = await childEnvironment(out);
    for (const key of keys) expect(env[key]).toBe("http://fake%3D:token@127.0.0.1:3128");
  });

  it.each(["darwin", "linux"] as const)(
    "uses safely quoted per-command defaults on %s",
    async (os) => {
      const cwd = "/tmp/my 'workspace'; $(printf injected) `printf injected`\nnext";
      const inherited = Object.freeze({
        TMPDIR: "/missing",
        TEMP: "/missing",
        PIP_CACHE_DIR: "/denied",
        HOME: "/home/unchanged",
      });
      const prepared = commandWithEnvironment(readEnvironment, cwd, os);
      expect(prepared.endsWith(`\n${readEnvironment}`)).toBe(true);
      const [first, second] = await Promise.all([
        childEnvironment(prepared, inherited),
        childEnvironment(commandWithEnvironment(readEnvironment, "/tmp/other", os), inherited),
      ]);
      expect(first).toMatchObject({
        TMPDIR: cwd,
        TEMP: cwd,
        TMP: cwd,
        XDG_CACHE_HOME: `${cwd}/.cache`,
        PIP_CACHE_DIR: `${cwd}/.cache/pip`,
        UV_CACHE_DIR: `${cwd}/.cache/uv`,
        MPLCONFIGDIR: `${cwd}/.cache/matplotlib`,
        HOME: "/home/unchanged",
      });
      expect(second.TMPDIR).toBe("/tmp/other");
      expect(second.UV_CACHE_DIR).toBe("/tmp/other/.cache/uv");
      expect(inherited.TMPDIR).toBe("/missing");
      expect(inherited.PIP_CACHE_DIR).toBe("/denied");
    },
  );

  it("allows explicit command overrides after the defaults", async () => {
    const command = `export PIP_CACHE_DIR=/tmp/chosen\n${readEnvironment}`;
    expect(
      await childEnvironment(commandWithEnvironment(command, "/tmp/work", "linux")),
    ).toMatchObject({
      TMPDIR: "/tmp/work",
      PIP_CACHE_DIR: "/tmp/chosen",
    });
  });
});

describe("Windows child environment", () => {
  it("replaces controlled overlays case-insensitively without changing the shell or proxies", () => {
    const cwd = "C:\\my work\\it's & (local)";
    const child = [
      "--",
      "C:\\Windows\\System32\\cmd.exe",
      "/d",
      "/s",
      "/c",
      "echo %TEMP% & echo --env TMP=mine",
    ];
    const argv = Object.freeze([
      "srt-win",
      "--env",
      "PATH=C:\\tools",
      "--env",
      "HTTPS_PROXY=http://fake@localhost:1234",
      "--env",
      "TEMP=C:\\denied",
      "--env",
      "Temp=C:\\also-denied",
      "--env",
      "PIP_CACHE_DIR=C:\\denied",
      ...child,
    ]);
    const out = forSandboxedChild(argv, cwd, "win32");
    expect(out.slice(0, 5)).toEqual(argv.slice(0, 5));
    expect(out.slice(out.indexOf("--"))).toEqual(child);
    expect(out.slice(5, out.indexOf("--"))).toEqual([
      "--env",
      `TEMP=${cwd}`,
      "--env",
      `TMP=${cwd}`,
      "--env",
      `XDG_CACHE_HOME=${cwd}\\.cache`,
      "--env",
      `PIP_CACHE_DIR=${cwd}\\.cache\\pip`,
      "--env",
      `UV_CACHE_DIR=${cwd}\\.cache\\uv`,
      "--env",
      `MPLCONFIGDIR=${cwd}\\.cache\\matplotlib`,
    ]);
    expect(out.some((arg) => /^(TMPDIR|NO_PROXY|no_proxy)=/.test(arg))).toBe(false);
    expect(commandWithEnvironment(child.at(-1)!, cwd, "win32")).toBe(child.at(-1));
    const other = forSandboxedChild(argv, "D:\\second", "win32");
    expect(other).toContain("TEMP=D:\\second");
    expect(out).toContain(`TEMP=${cwd}`);
  });

  it("refuses a missing child boundary rather than modifying the command", () => {
    expect(() =>
      forSandboxedChild(["srt-win", "cmd.exe", "/c", "echo hi"], "C:\\work", "win32"),
    ).toThrow("argument boundary");
  });
});
