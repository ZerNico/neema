import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { assertPublicHttpUrl } from "./url-safety.ts";

const rejects = (url: string) =>
  Effect.gen(function* () {
    const result = yield* assertPublicHttpUrl(url).pipe(Effect.flip);
    expect(result._tag).toBe("UnsafeUrl");
  });

describe("assertPublicHttpUrl", () => {
  it.effect("rejects non-http protocols", () => rejects("file:///etc/passwd"));
  it.effect("rejects ftp", () => rejects("ftp://example.com/x"));
  it.effect("rejects embedded credentials", () => rejects("https://user:pass@example.com/"));
  it.effect("rejects localhost", () => rejects("http://localhost:8080/admin"));
  it.effect("rejects loopback v4", () => rejects("http://127.0.0.1/"));
  it.effect("rejects loopback v4 range", () => rejects("http://127.8.8.8/"));
  it.effect("rejects rfc1918 10/8", () => rejects("http://10.0.0.5/"));
  it.effect("rejects rfc1918 172.16/12", () => rejects("http://172.20.1.1/"));
  it.effect("rejects rfc1918 192.168/16", () => rejects("http://192.168.1.1/"));
  it.effect("rejects link-local / cloud metadata", () => rejects("http://169.254.169.254/latest"));
  it.effect("rejects CGNAT", () => rejects("http://100.100.1.1/"));
  it.effect("rejects 0.0.0.0", () => rejects("http://0.0.0.0/"));
  it.effect("rejects ipv6 loopback", () => rejects("http://[::1]/"));
  it.effect("rejects ipv6 ULA", () => rejects("http://[fd00::1]/"));
  it.effect("rejects ipv6 link-local", () => rejects("http://[fe80::1]/"));
  it.effect("rejects ipv4-mapped ipv6 private", () => rejects("http://[::ffff:192.168.0.1]/"));
  it.effect("rejects single-label hostnames", () => rejects("http://intranet/"));
  it.effect("rejects invalid urls", () => rejects("not a url"));

  it.effect("accepts a public IP", () =>
    Effect.gen(function* () {
      const url = yield* assertPublicHttpUrl("https://1.1.1.1/dns");
      expect(url.hostname).toBe("1.1.1.1");
    }),
  );
});
