import { createConnection, Socket } from "node:net";
import { inspect } from "node:util";
import { expect, test, vi } from "vitest";
import * as hostModule from "../host.ts";
import { addressRefusal, type ProxyOptions } from "../index.ts";
import {
  allow,
  answer,
  auth,
  CONTEXT,
  deferred,
  established,
  fixture,
  nonStrings,
  PUBLIC,
  PUBLIC6,
  request,
  response,
  turn,
  write,
  type Fixture,
} from "./helpers.ts";

const metadata = [
  "100.100.100.200",
  "168.63.129.16",
  "192.0.0.192",
  "fd00:ec2::1",
  "fd00:ec2:ffff:ffff:ffff:ffff:ffff:ffff",
  "fd20:ce::254",
  "fd00:c1::a9fe:a9fe",
  "fd00:42::42",
  "fd00:a9fe:a9fe::1",
  "fd00:100::100:200",
];
const privateAddresses = [
  "10.1.2.3",
  "172.16.0.1",
  "172.31.255.255",
  "192.168.1.1",
  "100.64.0.1",
  "fd12::1",
  "fc00::1",
];
const refused = [
  "127.0.0.1",
  "0.1.2.3",
  "169.254.169.254",
  "224.0.0.1",
  "255.255.255.255",
  "240.0.0.1",
  "::",
  "fe80::1",
  "ff02::1",
  ...metadata,
  ...privateAddresses,
  "64:ff9b::7f00:1",
  "2002:7f00:1::",
  "::ffff:0:a9fe:a9fe",
  "::127.0.0.1",
  "::ffff:127.0.0.1",
  "64:ff9b:1::1",
];
for (const address of refused) {
  test(`a granted name resolving only to ${address} is refused`, async () => {
    const f = await fixture({ resolve: async () => answer(address) });
    const result = await response(await f.open(), 403, true);
    expect(result.body.length).toBeGreaterThan(0);
    expect(result.body).not.toContain(address);
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.onDenial).toHaveBeenCalledTimes(1);
    expect(f.proxy.tunnels()).toEqual([]);
  });
}

test.each(["127.1", "2130706433", "0x7f.0.0.1", "0177.0.0.1", "[::ffff:127.0.0.1]"])(
  "alternative literal %s cannot bypass the guard",
  async (literal) => {
    const f = await fixture({
      decide: (_context, host) => ({ allowed: host === "127.0.0.1", grantId: "literal" }),
    });
    await response(await f.open(`${literal}:443`), 403, true);
    expect(f.decide.mock.calls[0]?.[1]).toBe("127.0.0.1");
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
  },
);

test.each([PUBLIC, PUBLIC6, "10.1.2.3"])(
  "own interface %s is protected even with a private grant",
  async (address) => {
    const f = await fixture({
      resolve: async () => answer(address),
      interfaceAddresses: () => [address],
      decide: () => allow("private", true),
    });
    await response(await f.open(), 403, true);
    expect(f.connect).not.toHaveBeenCalled();
  },
);

test("interface enumeration is current for each new attempt", async () => {
  let own: string[] = [];
  const f = await fixture({ interfaceAddresses: () => own });
  await established(f);
  own = [PUBLIC];
  await response(await f.open(), 403, true);
  expect(f.connect).toHaveBeenCalledTimes(1);
});

test.each(privateAddresses)("a separate private-network grant admits %s", async (address) => {
  const f = await fixture({
    decide: () => allow("private", true),
    resolve: async () => answer(address),
  });
  await established(f);
  expect(f.connect).toHaveBeenCalledWith(address, 443, address.includes(":") ? 6 : 4);
});

test("a private literal uses its own permission without DNS", async () => {
  const f = await fixture({ decide: () => allow("private-literal", true) });
  await established(f, "10.1.2.3:443");
  expect(f.connect).toHaveBeenCalledWith("10.1.2.3", 443, 4);
  expect(f.resolve).not.toHaveBeenCalled();
});

test.each(["127.0.0.1", "169.254.169.254", ...metadata])(
  "a private grant never admits always-refused %s",
  async (address) => {
    const f = await fixture({
      decide: () => allow("private", true),
      resolve: async () => answer(address),
    });
    await response(await f.open(), 403, true);
    expect(f.connect).not.toHaveBeenCalled();
  },
);

test("mixed answers dial only surviving addresses in resolver order", async () => {
  const f = await fixture({
    resolve: async () => [
      { address: "127.0.0.1", family: 4 },
      { address: PUBLIC6, family: 6 },
      { address: PUBLIC, family: 4 },
    ],
  });
  await established(f);
  expect(f.connect.mock.calls).toEqual([[PUBLIC6, 443, 6]]);
  expect(f.onDenial).not.toHaveBeenCalled();
});

test("a failed first family falls back only among checked survivors", async () => {
  let f!: Fixture;
  f = await fixture({
    resolve: async () => [
      { address: PUBLIC6, family: 6 },
      { address: "127.0.0.1", family: 4 },
      { address: PUBLIC, family: 4 },
    ],
    connect: (address) => {
      if (address === PUBLIC6) {
        const socket = new Socket();
        queueMicrotask(() => socket.destroy(new Error("injected IPv6 connection refusal")));
        return socket;
      }
      return createConnection({ host: "127.0.0.1", port: f.upstreamPort, allowHalfOpen: true });
    },
  });
  await established(f);
  expect(f.connect.mock.calls).toEqual([
    [PUBLIC6, 443, 6],
    [PUBLIC, 443, 4],
  ]);
  expect(f.resolve).toHaveBeenCalledTimes(1);
});

test("refused category lists are stable under resolver permutations", async () => {
  const addresses = ["127.0.0.1", "10.1.2.3", "169.254.1.1"];
  let order = addresses;
  const f = await fixture({ resolve: async () => order.flatMap(answer) });
  const first = await response(await f.open(), 403, true);
  order = [addresses[2]!, addresses[0]!, addresses[1]!, addresses[0]!];
  const second = await response(await f.open(), 403, true);
  const categories = (text: string) =>
    (text.match(/loopback|private|link[- ]local/gi) ?? []).map((category) =>
      category.toLowerCase().replace(" ", "-"),
    );
  expect(categories(second.body)).toEqual(categories(first.body));
  expect(categories(f.denials[1]?.reason ?? "")).toEqual(categories(f.denials[0]?.reason ?? ""));
  expect(first.body).toMatch(/loopback/i);
  expect(first.body).toMatch(/private/i);
  expect(first.body).toMatch(/link.local/i);
  for (const address of addresses) expect(first.body).not.toContain(address);
});

test.each(["error", "empty"])("DNS %s is a network failure, not a violation", async (mode) => {
  const f = await fixture({
    resolve: async () => {
      if (mode === "error") throw new Error("DNS failed");
      return [];
    },
  });
  await response(await f.open(), 502);
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.onDenial).not.toHaveBeenCalled();
});

test("rebinding cannot cause a second lookup or hostname dial", async () => {
  let calls = 0;
  const f = await fixture({ resolve: async () => answer(++calls === 1 ? PUBLIC : "127.0.0.1") });
  await established(f);
  expect(calls).toBe(1);
  expect(f.connect).toHaveBeenCalledExactlyOnceWith(PUBLIC, 443, 4);
});

test("unavailable interface enumeration fails closed as a proxy fault", async () => {
  const f = await fixture({
    interfaceAddresses: () => {
      throw new Error("interfaces unavailable");
    },
  });
  await response(await f.open(), 500);
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.onDenial).not.toHaveBeenCalled();
  expect(f.proxy.tunnels()).toEqual([]);
});

const alwaysRefused = [
  "127.0.0.0",
  "127.255.255.255",
  "::1",
  "0.0.0.0",
  "0.255.255.255",
  "::",
  "169.254.0.0",
  "169.254.255.255",
  "fe80::",
  "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  "224.0.0.0",
  "239.255.255.255",
  "ff00::",
  "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  "240.0.0.0",
  "255.255.255.254",
  "255.255.255.255",
  ...metadata,
  "64:ff9b::7f00:1",
  "2002:7f00:1::",
  "::ffff:0:a9fe:a9fe",
  "::127.0.0.1",
  "::ffff:127.0.0.1",
  "64:ff9b:1::",
  "64:ff9b:1:ffff:ffff:ffff:ffff:ffff",
];

test.each(alwaysRefused)("addressRefusal always refuses %s even with private opt-in", (address) => {
  for (const privateNetwork of [false, true]) {
    const reason = addressRefusal(address, [], privateNetwork);
    expect(typeof reason).toBe("string");
    expect(reason?.length).toBeGreaterThan(0);
  }
});

test.each([
  ...privateAddresses,
  "10.0.0.0",
  "10.255.255.255",
  "172.16.0.0",
  "192.168.0.0",
  "192.168.255.255",
  "100.64.0.0",
  "100.127.255.255",
  "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  "64:ff9b::a01:203",
  "2002:a01:203::",
  "::ffff:0:a01:203",
])("addressRefusal private opt-in changes only private %s", (address) => {
  expect(addressRefusal(address, [], false)).toEqual(expect.any(String));
  expect(addressRefusal(address, [], true)).toBeNull();
});

test.each([
  PUBLIC,
  PUBLIC6,
  "1.0.0.0",
  "126.255.255.255",
  "128.0.0.0",
  "169.253.255.255",
  "169.255.0.0",
  "223.255.255.255",
  "9.255.255.255",
  "11.0.0.0",
  "172.15.255.255",
  "172.32.0.0",
  "192.167.255.255",
  "192.169.0.0",
  "100.63.255.255",
  "100.128.0.0",
  "64:ff9b::808:808",
  "2002:808:808::",
  "::ffff:0:808:808",
  "::8.8.8.8",
])("addressRefusal permits non-protected %s", (address) => {
  expect(addressRefusal(address, [], false)).toBeNull();
});

test.each([
  [PUBLIC, PUBLIC],
  ["2001:4860:4860:0:0:0:0:8888", PUBLIC6],
  ["::ffff:93.184.216.34", PUBLIC],
  [PUBLIC, "::ffff:93.184.216.34"],
  ["64:ff9b::5db8:d822", PUBLIC],
])("own interface comparison normalizes %s against %s", (address, own) => {
  expect(addressRefusal(address, [own], true)).toEqual(expect.any(String));
});

test.each(["::1", "fe80::1", "64:ff9b::7f00:1", "fd00:ec2::254"])(
  "a literal grant cannot dial protected IPv6 %s",
  async (address) => {
    const f = await fixture({
      decide: (_context, host, port) =>
        host === address && port === 443 ? allow() : { allowed: false },
    });
    await response(await f.open(`[${address}]:443`), 403, true);
    expect(f.decide).toHaveBeenCalledWith(CONTEXT, address, 443);
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
  },
);

test("a mapped IPv6 DNS answer is dialed as canonical IPv4", async () => {
  const f = await fixture({ resolve: async () => answer("::ffff:93.184.216.34") });
  await established(f);
  expect(f.connect).toHaveBeenCalledExactlyOnceWith(PUBLIC, 443, 4);
});

test("a non-IP resolver answer never reaches connect", async () => {
  const f = await fixture({ resolve: async () => answer("attacker.example") });
  await response(await f.open(), 403, true);
  expect(f.connect).not.toHaveBeenCalled();
});

const malformedAnswers: unknown[] = [
  undefined,
  null,
  42,
  "addresses",
  {},
  { length: 0 },
  [null],
  [undefined],
  ["93.184.216.34"],
  [42],
  [{}],
  [{ address: null, family: 4 }],
  [{ address: PUBLIC, family: "4" }],
  [answer(PUBLIC)[0], null],
];
for (const value of malformedAnswers) {
  test(`malformed resolver result ${inspect(value, { breakLength: Infinity })} faults without an unhandled rejection`, async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const settled = deferred<void>();
      const f = await fixture({
        resolve: async () => {
          settled.resolve();
          // Deliberately outside the signature: an injected resolver may return anything at runtime.
          return value as Awaited<ReturnType<NonNullable<ProxyOptions["resolve"]>>>;
        },
      });
      const client = await f.open();
      await settled.promise;
      // One event-loop turn observes promise rejection delivery, not elapsed time.
      await turn();
      expect(unhandled).not.toHaveBeenCalled();
      // Past the deadline, a silently ignored result fails as 502 instead of hanging the test.
      f.clock.advance(30_000);
      await response(client, 500);
      expect(f.connect).not.toHaveBeenCalled();
      expect(f.onDenial).not.toHaveBeenCalled();
      await turn();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener("unhandledRejection", unhandled);
    }
  });
}

test("exclusively network failures across fallback return 502 without a denial", async () => {
  const f = await fixture({
    resolve: async () => [...answer(PUBLIC), ...answer("93.184.216.35")],
    connect: () => {
      throw new Error("network refused");
    },
  });
  await response(await f.open(), 502);
  expect(f.connect).toHaveBeenCalledTimes(2);
  expect(f.onDenial).not.toHaveBeenCalled();
});

test("fallback refreshes interfaces before dialing a newly local candidate", async () => {
  const started = deferred<void>();
  const first = new Socket();
  let local: string[] = [];
  const f = await fixture({
    resolve: async () => [...answer(PUBLIC), ...answer("93.184.216.35")],
    interfaceAddresses: () => local,
    connect: () => {
      started.resolve();
      return first;
    },
  });
  const client = await f.open();
  await started.promise;
  local = ["93.184.216.35"];
  first.destroy(new Error("first candidate refused"));
  const barrier = await f.client();
  await write(barrier.socket, request("/", auth(f.token), [], "GET"));
  await response(barrier, 403, true);
  expect(f.connect).toHaveBeenCalledTimes(1);
  await response(client, 403, true);
});

test("interface enumeration failing during fallback is an internal fault", async () => {
  const started = deferred<void>();
  let broken = false;
  const first = new Socket();
  const f = await fixture({
    resolve: async () => [...answer(PUBLIC), ...answer("93.184.216.35")],
    interfaceAddresses: () => {
      if (broken) throw new Error("interfaces unavailable");
      return [];
    },
    connect: () => {
      started.resolve();
      return first;
    },
  });
  const client = await f.open();
  await started.promise;
  broken = true;
  first.destroy(new Error("dial refused"));
  const barrier = await f.client();
  await write(barrier.socket, request("/", auth(f.token), [], "GET"));
  await response(barrier, 403, true);
  expect(f.connect).toHaveBeenCalledTimes(1);
  await response(client, 500);
});

test("an invalid interface entry is an internal fault rather than a policy denial", async () => {
  const f = await fixture({ interfaceAddresses: () => ["not-an-address"] });
  await response(await f.open(), 500);
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.onDenial).not.toHaveBeenCalled();
});

test.each(["not an IP", "example.com", "fe80::1%en0"])(
  "addressRefusal fails closed on invalid interface %s",
  (invalid) => {
    expect(addressRefusal(PUBLIC, [invalid], false)).toBe("interface list invalid");
  },
);

test("addressRefusal prepares its own interface list, carried IPv4 included", () => {
  expect(addressRefusal("::ffff:93.184.216.34", [PUBLIC], false)).toBe("host interface");
  expect(addressRefusal(PUBLIC, ["::ffff:93.184.216.34"], false)).toBe("host interface");
  expect(addressRefusal(PUBLIC, ["not an address"], false)).toBe("interface list invalid");
  expect(addressRefusal("nope", ["not an address"], false)).toBe("invalid address");
  expect(addressRefusal(PUBLIC, ["192.0.2.1"], false)).toBeNull();
});

for (const [label, value] of nonStrings) {
  test(`addressRefusal rejects ${label} without throwing`, () => {
    // Deliberately outside the signature: callers may pass untyped runtime values.
    expect(addressRefusal(value as string, [], false)).toBe("invalid address");
  });
}

test("initial address filtering does linear normalization work in candidates plus interfaces", async () => {
  const work = async (n: number) => {
    const candidates = Array.from({ length: n }, (_, i) => ({
      address: `10.0.${i >> 8}.${i & 255}`,
      family: 4 as const,
    }));
    const interfaces = Array.from({ length: n }, (_, i) => `198.18.${i >> 8}.${i & 255}`);
    const f = await fixture({
      decide: () => allow(),
      resolve: async () => candidates,
      interfaceAddresses: () => interfaces,
      log: vi.fn(),
    });
    const canonical = vi.spyOn(hostModule, "canonicalHost");
    const result = await response(await f.open(), 403, true);
    expect(result.body).toMatch(/private network/);
    expect(f.connect).not.toHaveBeenCalled();
    const calls = canonical.mock.calls.length;
    canonical.mockRestore();
    return calls;
  };
  const small = await work(64);
  const large = await work(128);
  expect(small).toBeGreaterThan(64);
  expect(large).toBeLessThanOrEqual(4 * 128);
  expect(large / small).toBeLessThan(2.2);
});
