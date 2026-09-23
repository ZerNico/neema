import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { Effect } from "effect";
import { assertPublicHttpUrl, lookupPinned, resolvePublicHttpUrl } from "./url-safety.ts";

// Hostname resolution is stubbed so those cases are deterministic and offline;
// IP-literal cases never hit DNS.
const { lookupMock } = vi.hoisted(() => ({
  lookupMock: vi.fn<() => Promise<Array<{ address: string; family: number }>>>(),
}));
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

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
  it.effect("rejects ipv4-mapped ipv6 hex private", () => rejects("http://[::ffff:c0a8:1]/"));
  it.effect("rejects ipv4-compatible ipv6 loopback", () => rejects("http://[::127.0.0.1]/"));
  it.effect("rejects ipv4-compatible ipv6 hex loopback", () => rejects("http://[::7f00:1]/"));
  it.effect("rejects ipv4-translated ipv6 private", () =>
    rejects("http://[::ffff:0:192.168.0.1]/"),
  );
  it.effect("rejects nat64 ipv6 private", () => rejects("http://[64:ff9b::192.168.0.1]/"));
  it.effect("rejects 6to4 ipv6 private", () => rejects("http://[2002:c0a8:1::1]/"));
  it.effect("rejects single-label hostnames", () => rejects("http://intranet/"));
  it.effect("rejects invalid urls", () => rejects("not a url"));

  it.effect("accepts a public IP", () =>
    Effect.gen(function* () {
      const url = yield* assertPublicHttpUrl("https://1.1.1.1/dns");
      expect(url.hostname).toBe("1.1.1.1");
    }),
  );

  it.effect("accepts a hostname resolving to public addresses only", () =>
    Effect.gen(function* () {
      lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
      const url = yield* assertPublicHttpUrl("https://example.com/page");
      expect(url.hostname).toBe("example.com");
    }),
  );

  it.effect("returns those addresses so the fetch can pin them", () =>
    Effect.gen(function* () {
      lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
      const target = yield* resolvePublicHttpUrl("https://example.com/page");
      expect(target.addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
    }),
  );

  it.effect("accepts a public ipv4-mapped ipv6 address", () =>
    Effect.gen(function* () {
      const url = yield* assertPublicHttpUrl("https://[::ffff:1.1.1.1]/dns");
      expect(url.hostname.replace(/^\[|\]$/g, "")).toMatch(/^::ffff:/);
    }),
  );

  it.effect("rejects a hostname when any DNS answer is private", () =>
    Effect.gen(function* () {
      // One poisoned record rejects the whole set: rebinding-style setups
      // mix a public address with the internal target.
      lookupMock.mockResolvedValueOnce([
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.7", family: 4 },
      ]);
      yield* rejects("https://rebind.example.com/");
    }),
  );

  it.effect("rejects a hostname that does not resolve", () =>
    Effect.gen(function* () {
      lookupMock.mockRejectedValueOnce(new Error("ENOTFOUND"));
      yield* rejects("https://nope.invalid/");
    }),
  );
});

describe("lookupPinned", () => {
  it("connects to the checked address and ignores the hostname", () => {
    const lookup = lookupPinned([{ address: "1.1.1.1", family: 4 }]);
    lookup("rebind.example.com", {}, (error, address, family) => {
      expect(error).toBeNull();
      expect(address).toBe("1.1.1.1");
      expect(family).toBe(4);
    });
  });
});
