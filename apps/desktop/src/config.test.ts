import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isConfiguredOriginUrl,
  isSafeExternalUrl,
  readConfig,
  bridgeableOrigin,
  toOrigin,
  writeConfig,
} from "./config.ts";

/**
 * `toOrigin` decides who may reach the bridge, so its job is to collapse every
 * spelling of one server onto a single string and to refuse anything that is
 * not a server. A comparison against a stored path or a stored query would
 * succeed for URLs that only share a prefix.
 */
describe("normalising a server address", () => {
  it("collapses paths, queries and trailing slashes onto the origin", () => {
    for (const input of [
      "https://chat.example.com",
      "https://chat.example.com/",
      "https://chat.example.com/chat/123",
      "https://chat.example.com/?x=1",
      "  https://chat.example.com/chat  ",
    ]) {
      expect(toOrigin(input)).toBe("https://chat.example.com");
    }
  });

  it("assumes https when no scheme is given, rather than http", () => {
    expect(toOrigin("chat.example.com")).toBe("https://chat.example.com");
  });

  it("keeps the port, since a different port is a different server", () => {
    expect(toOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(toOrigin("http://localhost:3000")).not.toBe(toOrigin("http://localhost:3001"));
  });

  it("does not treat a lookalike host as the same origin", () => {
    expect(toOrigin("https://chat.example.com.evil.test")).not.toBe(
      toOrigin("https://chat.example.com"),
    );
    expect(toOrigin("https://evil.test/https://chat.example.com")).toBe("https://evil.test");
  });

  it("treats only the configured origin as the signed-in page", () => {
    expect(
      isConfiguredOriginUrl("https://chat.example.com/login", "https://chat.example.com"),
    ).toBe(true);
    expect(isConfiguredOriginUrl("file:///tmp/recovery.html", "https://chat.example.com")).toBe(
      false,
    );
    expect(isConfiguredOriginUrl("https://chat.example.com/login", null)).toBe(false);
  });

  it("refuses anything that is not an http server", () => {
    for (const input of [
      "",
      "   ",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,x",
    ]) {
      expect(toOrigin(input)).toBeNull();
    }
  });
});

describe("URLs handed to the OS", () => {
  it("allows only http and https", () => {
    expect(isSafeExternalUrl("https://chat.example.com/login")).toBe(true);
    expect(isSafeExternalUrl("http://localhost:3000/desktop/sign-in")).toBe(true);
  });

  it("refuses file, javascript and custom schemes", () => {
    for (const input of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,x",
      "ms-msdt:something",
      "chat-desktop://sign-in?ticket=x",
      "not a url",
    ]) {
      expect(isSafeExternalUrl(input)).toBe(false);
    }
  });
});

describe("the stored server", () => {
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "chat-config-"));
    file = join(dir, "server.json");
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips as an origin", async () => {
    await writeConfig(file, { serverUrl: "https://chat.example.com" });
    expect(await readConfig(file)).toEqual({ serverUrl: "https://chat.example.com" });
  });

  it("re-normalises on read, so a hand-edited file cannot widen the match", async () => {
    await writeFile(file, JSON.stringify({ serverUrl: "https://chat.example.com/anything" }));
    expect(await readConfig(file)).toEqual({ serverUrl: "https://chat.example.com" });
  });

  it("reads a saved plain-http address on the network as not configured", async () => {
    await writeFile(file, JSON.stringify({ serverUrl: "http://chat.lan" }));
    expect(await readConfig(file)).toBeNull();
    await writeFile(file, JSON.stringify({ serverUrl: "http://localhost:3000" }));
    expect(await readConfig(file)).toEqual({ serverUrl: "http://localhost:3000" });
  });

  it("reads a missing, corrupt or unusable file as not configured", async () => {
    expect(await readConfig(join(dir, "absent.json"))).toBeNull();

    await writeFile(file, "not json");
    expect(await readConfig(file)).toBeNull();

    await writeFile(file, JSON.stringify({ serverUrl: "file:///etc" }));
    expect(await readConfig(file)).toBeNull();
  });
});

describe("bridgeableOrigin", () => {
  it("hands the bridge to https, and to http only on this machine", () => {
    expect(bridgeableOrigin("https://chat.example.com")).toBe(true);
    for (const origin of [
      "http://localhost:3000",
      "http://chat.localhost",
      "http://127.0.0.1:8080",
      "http://[::1]:3000",
    ])
      expect(bridgeableOrigin(origin)).toBe(true);
    for (const origin of ["http://chat.lan", "http://192.168.1.10", "http://localhost.evil.com"])
      expect(bridgeableOrigin(origin)).toBe(false);
  });
});
