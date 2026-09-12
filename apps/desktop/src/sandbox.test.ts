import { describe, expect, it } from "vitest";
import { forSandboxedChild } from "./sandbox.ts";

// srt returns `bash -c "env VAR=value ... /usr/bin/sandbox-exec -p <profile> bash -c <cmd>"`.
const script =
  "env SANDBOX_RUNTIME=1 NO_PROXY=localhost,127.0.0.1 HTTPS_PROXY=http://srt.cDE%3D:tok@localhost:3128 " +
  "HTTP_PROXY=http://localhost:3128 ftp_proxy=socks5h://srt:tok@localhost:3128 " +
  "CLOUDSDK_PROXY_ADDRESS=localhost RSYNC_PROXY=localhost:3128 " +
  "/usr/bin/sandbox-exec -p '(version 1) (allow network-outbound (remote ip \"localhost:3128\"))' " +
  "/bin/bash -c 'curl http://localhost:8080 && echo localhost'";
const argv = ["/bin/bash", "-c", script];

describe("forSandboxedChild", () => {
  it("points every proxy variable at numeric loopback, credentials intact", () => {
    const out = forSandboxedChild(argv, "/tmp/work")[2]!;
    // Seatbelt denies the name lookup, so `localhost` never reaches the proxy.
    expect(out).toContain("HTTPS_PROXY=http://srt.cDE%3D:tok@127.0.0.1:3128");
    expect(out).toContain("HTTP_PROXY=http://127.0.0.1:3128");
    expect(out).toContain("ftp_proxy=socks5h://srt:tok@127.0.0.1:3128");
    expect(out).toContain("CLOUDSDK_PROXY_ADDRESS=127.0.0.1");
    expect(out).toContain("RSYNC_PROXY=127.0.0.1:3128");
    // The bypass list is a list of names, not a URL; left as srt wrote it.
    expect(out).toContain("NO_PROXY=localhost,127.0.0.1");
    // The profile and the user's own command are not the shell's variables.
    expect(out).toContain('(remote ip "localhost:3128")');
    expect(out).toContain("curl http://localhost:8080 && echo localhost");
  });

  it("keeps pip's cache inside the only writable path", () => {
    const out = forSandboxedChild(argv, "/tmp/my work")[2]!;
    expect(out.startsWith("env PIP_CACHE_DIR='/tmp/my work/.cache/pip' SANDBOX_RUNTIME=1")).toBe(
      true,
    );
    const already = forSandboxedChild(
      ["/bin/bash", "-c", "env PIP_CACHE_DIR=/x true"],
      "/tmp/work",
    );
    expect(already[2]).toBe("env PIP_CACHE_DIR=/x true");
  });

  it("preserves the executable and user command suffix byte-for-byte", () => {
    const suffix =
      "/usr/bin/sandbox-exec -p 'HTTP_PROXY=http://localhost:90' bash -c 'HTTPS_PROXY=http://localhost:8000 curl x; printf \"PIP_CACHE_DIR=mine\"'";
    const prefix = "env HTTPS_PROXY=http://localhost:3128 OTHER='has spaces' ";
    const out = forSandboxedChild(["bash", "-c", prefix + suffix], "/tmp")[2]!;
    expect(out.endsWith(suffix)).toBe(true);
    expect(out).toContain("HTTPS_PROXY=http://127.0.0.1:3128");
    expect(out).toContain("PIP_CACHE_DIR='/tmp/.cache/pip'");
  });

  it("leaves anything that is not the env script alone", () => {
    expect(forSandboxedChild(["/bin/bash", "-c", "echo localhost"], "/tmp")).toEqual([
      "/bin/bash",
      "-c",
      "echo localhost",
    ]);
  });
});
