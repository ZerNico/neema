import { expect, test } from "vitest";
import { canonicalHost } from "../index.ts";
import {
  allow,
  answer,
  CONTEXT,
  established,
  fixture,
  nonStrings,
  PUBLIC6,
  response,
} from "./helpers.ts";

const canonical: Array<[string, string, "name" | "ipv4" | "ipv6"]> = [
  ["Example.COM.", "example.com", "name"],
  ["xn--bcher-kva.example", "xn--bcher-kva.example", "name"],
  ["_service.example", "_service.example", "name"],
  ["127.1", "127.0.0.1", "ipv4"],
  ["2130706433", "127.0.0.1", "ipv4"],
  ["0x7f.0.0.1", "127.0.0.1", "ipv4"],
  ["0177.0.0.1", "127.0.0.1", "ipv4"],
  ["2001:0DB8:0000:0000:0000:0000:0000:0001", "2001:db8::1", "ipv6"],
  ["::ffff:127.0.0.1", "127.0.0.1", "ipv4"],
  ["::ffff:7f00:1", "127.0.0.1", "ipv4"],
  ["8.8.8.8", "8.8.8.8", "ipv4"],
];
test.each(canonical)("canonicalHost(%s) is %s and stable", (raw, host, kind) => {
  expect(canonicalHost(raw)).toEqual({ ok: true, host, kind });
  expect(canonicalHost(host)).toEqual({ ok: true, host, kind });
});

const invalid = [
  "",
  ".",
  "example.com..",
  "a..b",
  "-a.example",
  "a-.example",
  "a".repeat(64),
  "a.".repeat(127),
  "%65xample.com",
  "bücher.example",
  "a\0example.com",
  "a\rexample.com",
  "a\nexample.com",
  "a example.com",
  "a\texample.com",
  "a/example.com",
  "a\\example.com",
  "a@example.com",
  "fe80::1%en0",
  "[example.com]",
  "*.example.com",
  "999.0.0.1",
  "1.2.3.999",
];
test.each(invalid)("canonicalHost rejects %j without raw fallback", (raw) => {
  expect(canonicalHost(raw)).toEqual({ ok: false, reason: expect.any(String) });
});

test("canonicalization rejects controls even after a public IPv4 spelling", () => {
  for (const ending of ["\n", "\r", "\r\n", " ", " "]) {
    expect(canonicalHost("8.8.8.8" + ending).ok).toBe(false);
  }
});

for (const [label, value] of nonStrings) {
  test(`canonicalHost rejects ${label} without throwing`, () => {
    // Deliberately outside the signature: callers may pass untyped runtime values.
    expect(canonicalHost(value as string)).toMatchObject({ ok: false });
  });
}

test("maximum host and label lengths are accepted", () => {
  const host = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join(".");
  expect(host).toHaveLength(253);
  expect(canonicalHost(host)).toEqual({ ok: true, host, kind: "name" });
});

test("the canonical spelling reaches both policy and resolver", async () => {
  const f = await fixture();
  await established(f, "Example.COM.:443");
  expect(f.decide).toHaveBeenCalledExactlyOnceWith(CONTEXT, "example.com", 443);
  expect(f.resolve).toHaveBeenCalledExactlyOnceWith("example.com", expect.any(AbortSignal));
  expect(f.proxy.tunnels()).toEqual([
    { context: CONTEXT, host: "example.com", port: 443, grantId: "grant-a" },
  ]);
});

const refused = [
  "example.com..:443",
  "%65xample.com:443",
  "bücher.example:443",
  `${"a".repeat(64)}.example:443`,
  "a..b:443",
  "-a:443",
];
for (const target of refused) {
  test(`invalid host ${JSON.stringify(target)} is a policy refusal`, async () => {
    const f = await fixture({ decide: () => allow() });
    await response(await f.open(target), 403, true);
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
  });
}

for (const target of ["example.com:8443", "a.example.com:443"]) {
  test(`an exact grant does not authorize ${target}`, async () => {
    const f = await fixture();
    await response(await f.open(target), 403, true);
    expect(f.connect).not.toHaveBeenCalled();
  });
}

test.each(["a.b.example.com", "example.com", "notexample.com"])(
  "a builtin wildcard policy result for %s is respected",
  async (host) => {
    // Grant storage/matching belongs to the injected desktop policy, not this module.
    const f = await fixture({
      decide: (_context, name, port) => ({
        allowed: name.endsWith(".example.com") && port === 443,
        grantId: "builtin-wildcard",
        reason: "No builtin subdomain grant",
      }),
    });
    if (host === "a.b.example.com") await established(f, `${host}:443`);
    else {
      await response(await f.open(`${host}:443`), 403, true);
      expect(f.connect).not.toHaveBeenCalled();
    }
    expect(f.decide).toHaveBeenCalledWith(CONTEXT, host, 443);
  },
);

test("user-grant host validation refuses a wildcard at the shared canonicalization boundary", () => {
  expect(canonicalHost("*.example.com")).toEqual({ ok: false, reason: expect.any(String) });
});

test.each([
  "bad\0example.com:443",
  "bad\rexample.com:443",
  "bad\nexample.com:443",
  "bad\r\nProxy-Authorization: attacker\r\nexample.com:443",
  "[fe80::1%en0]:443",
])("control or zone input %j never changes authority", async (target) => {
  const f = await fixture({ decide: () => allow() });
  const client = await f.open(target);
  const head = await client.head();
  expect([400, 403]).toContain(head.status);
  await client.finish();
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.resolve).not.toHaveBeenCalled();
});

test("punycode with its exact grant is accepted", async () => {
  const f = await fixture({
    decide: (_context, host, port) => ({
      allowed: host === "xn--bcher-kva.example" && port === 443,
      grantId: "idn",
    }),
  });
  await established(f, "xn--bcher-kva.example:443");
});

test("expanded and compressed IPv6 have identical policy, guard and dial identities", async () => {
  const f = await fixture({
    decide: (_context, host) => ({ allowed: host === PUBLIC6, grantId: "ipv6" }),
    resolve: async () => answer(PUBLIC6),
  });
  await established(f, "[2001:4860:4860:0000:0000:0000:0000:8888]:443");
  await established(f, `[${PUBLIC6}]:443`);
  expect(f.decide.mock.calls.map((call) => call.slice(1))).toEqual([
    [PUBLIC6, 443],
    [PUBLIC6, 443],
  ]);
  expect(f.connect.mock.calls).toEqual([
    [PUBLIC6, 443, 6],
    [PUBLIC6, 443, 6],
  ]);
  expect(f.resolve).not.toHaveBeenCalled();
});

test("a cross-scope deny from the authoritative grant callback wins", async () => {
  const f = await fixture({
    decide: () => ({ allowed: false, grantId: "always-allow", reason: "Denied by chat policy" }),
  });
  const result = await response(await f.open(), 403, true);
  expect(result.body).toContain("Denied by chat policy");
  expect(f.resolve).not.toHaveBeenCalled();
  expect(f.connect).not.toHaveBeenCalled();
});
