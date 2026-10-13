import { inspect } from "node:util";
import { Socket } from "node:net";
import { expect, test, vi } from "vitest";
import type { ProxyOptions } from "../index.ts";
import {
  allow,
  answer,
  auth,
  CONTEXT,
  deferred,
  established,
  fixture,
  PUBLIC,
  request,
  response,
  write,
} from "./helpers.ts";

function captureLogs() {
  const entries: string[] = [];
  for (const level of ["debug", "info", "log", "warn", "error", "trace"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      entries.push(inspect(args, { depth: 10 }));
    });
  }
  const capture = (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    entries.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    if (typeof encoding === "function") encoding();
    else callback?.();
    return true;
  };
  vi.spyOn(process.stdout, "write").mockImplementation(capture);
  vi.spyOn(process.stderr, "write").mockImplementation(capture);
  return entries;
}

test("a parser-error response to an unread client has a close backstop", async () => {
  const f = await fixture();
  const client = await f.client();
  client.socket.pause();
  await write(client.socket, Buffer.from("INV(ALID / HTTP/1.1\r\n\r\n"));
  // A separate valid request is an I/O barrier; no real-time timer is used to wait.
  const barrier = await established(f);
  await write(barrier.client.socket, "ready");
  await barrier.peer.read(5);
  f.clock.advance(30_000);
  client.socket.resume();
  await client.finish();
  expect(client.transcript.toString()).toMatch(/^HTTP\/1\.[01] 400/);
});

test("a successful tunnel is opaque even when its bytes look like HTTP", async () => {
  const f = await fixture({ decide: () => allow() });
  const { client, peer } = await established(f, "example.com:22");
  const payload = Buffer.from(
    "SSH-2.0-test\r\nHTTP/1.1 403 remote-protocol-data\r\n\0\xff",
    "latin1",
  );
  await write(client.socket, payload);
  expect(await peer.read(payload.length)).toEqual(payload);
  await write(peer.socket, payload);
  expect(await client.read(payload.length)).toEqual(payload);
  expect(f.onDenial).not.toHaveBeenCalled();
});

test("a thrown decision callback is an internal fault, not a policy denial", async () => {
  const f = await fixture({
    decide: () => {
      throw new Error("grant store unavailable");
    },
  });
  await response(await f.open(), 500);
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.onDenial).not.toHaveBeenCalled();
  expect(f.proxy.tunnels()).toEqual([]);
});

test("a denial is reported exactly once with the complete command context and canonical authority", async () => {
  const f = await fixture({
    decide: () => ({ allowed: false, reason: "Host has no approved grant" }),
  });
  const result = await response(await f.open("Example.COM.:8443"), 403, true);
  expect(f.denials).toEqual([
    {
      context: CONTEXT,
      host: "example.com",
      port: 8443,
      reason: "Host has no approved grant",
    },
  ]);
  expect(result.body).toContain("Host has no approved grant");
  expect(JSON.stringify(f.denials)).not.toContain(f.token);
  expect(result.raw + result.body).not.toContain(f.token);
  expect(f.onDenial).toHaveBeenCalledTimes(1);
});

test("console, stdout, stderr, reports and diagnostics never expose credentials", async () => {
  let mode: "denial" | "network" | "success" = "denial";
  const f = await fixture({
    decide: () => (mode === "denial" ? { allowed: false, reason: "No grant" } : allow()),
    resolve: async () => {
      if (mode === "network") throw new Error("DNS failed");
      return answer(PUBLIC);
    },
  });
  const logs = captureLogs();
  const client = await f.client();
  await write(
    client.socket,
    request("example.com:443", auth(f.token), [`Proxy-Authorization: ${auth(f.token)}`]),
  );
  await response(client, 407);
  await response(await f.open(), 403, true);
  mode = "network";
  await response(await f.open(), 502);
  mode = "success";
  await established(f);
  const output = [...logs, JSON.stringify(f.denials), JSON.stringify(f.proxy.tunnels())].join("\n");
  expect(output).not.toContain(f.token);
  expect(output).not.toContain(auth(f.token));
  expect(output).not.toContain(auth(f.token).slice(6));
});

test("a mixed DNS refusal is logged without turning a successful tunnel into a violation", async () => {
  const f = await fixture({ resolve: async () => [...answer("127.0.0.1"), ...answer(PUBLIC)] });
  const logs = captureLogs();
  await established(f);
  expect(logs.join("\n")).toMatch(/127\.0\.0\.1/);
  expect(logs.join("\n")).not.toContain(f.token);
  expect(f.onDenial).not.toHaveBeenCalled();
});

test("an interface-enumeration fault is reported through diagnostics, not onDenial", async () => {
  const f = await fixture({
    interfaceAddresses: () => {
      throw new Error("interface enumeration failed");
    },
  });
  const logs = captureLogs();
  await response(await f.open(), 500);
  expect(logs.length).toBeGreaterThan(0);
  expect(f.onDenial).not.toHaveBeenCalled();
  expect(f.connect).not.toHaveBeenCalled();
});

test.each(["DNS error", "empty DNS", "TCP refusal", "deadline"])(
  "%s is logged but is never a violation",
  async (failure) => {
    const started = deferred<void>();
    const f = await fixture({
      resolve: async () => {
        if (failure === "DNS error") throw new Error("DNS failed");
        if (failure === "empty DNS") return [];
        return answer(PUBLIC);
      },
      connect: () => {
        const socket = new Socket();
        if (failure === "TCP refusal")
          queueMicrotask(() => socket.destroy(new Error("TCP refused")));
        started.resolve();
        return socket;
      },
      limits: { establishMs: 100 },
    });
    const logs = captureLogs();
    const client = await f.open();
    if (failure === "deadline") {
      await started.promise;
      await f.clock.scheduled(100);
      f.clock.advance(100);
    }
    await response(client, failure === "deadline" ? [502, 504] : 502);
    expect(f.denials).toEqual([]);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toContain(f.token);
  },
);

for (const source of ["resolve", "connect", "interfaceAddresses", "decide", "onDenial"] as const) {
  test(`${source} exceptions never leak secrets to custom logs or streams`, async () => {
    let secret = "";
    const fail = () => {
      throw new Error(secret);
    };
    const failing: Partial<ProxyOptions> = {
      ...(source === "resolve" ? { resolve: async () => fail() } : {}),
      ...(source === "connect" ? { connect: fail } : {}),
      ...(source === "interfaceAddresses" ? { interfaceAddresses: fail } : {}),
      ...(source === "decide" ? { decide: fail } : {}),
      ...(source === "onDenial" ? { onDenial: fail, decide: () => ({ allowed: false }) } : {}),
    };
    const log = vi.fn();
    const f = await fixture({ ...failing, log });
    secret = `${f.token} ${auth(f.token)}`;
    const output: unknown[] = [];
    for (const level of ["info", "warn", "error", "log", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => {
        output.push(args);
      });
    }
    const capture = (
      chunk: string | Uint8Array,
      encoding?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ) => {
      output.push(chunk);
      if (typeof encoding === "function") encoding();
      else callback?.();
      return true;
    };
    vi.spyOn(process.stdout, "write").mockImplementation(capture);
    vi.spyOn(process.stderr, "write").mockImplementation(capture);
    const status =
      source === "onDenial" ? 403 : source === "resolve" || source === "connect" ? 502 : 500;
    await response(await f.open(), status, status === 403);
    const text = inspect([log.mock.calls, output], { depth: 20 });
    expect(text).not.toContain(f.token);
    expect(text).not.toContain(auth(f.token));
    expect(text).not.toContain(auth(f.token).slice(6));
    expect(log).toHaveBeenCalled();
    expect(output).toEqual([]);
    for (const call of log.mock.calls) {
      expect(call).toHaveLength(2);
      expect(["info", "warn", "error"]).toContain(call[0]);
      expect(typeof call[1]).toBe("string");
    }
    const defaultLogger = await fixture(failing);
    secret = `${defaultLogger.token} ${auth(defaultLogger.token)}`;
    await response(await defaultLogger.open(), status, status === 403);
    expect(output.length).toBeGreaterThan(0);
    const allLogs = inspect([log.mock.calls, output], { depth: 20 });
    for (const token of [f.token, defaultLogger.token]) {
      expect(allLogs).not.toContain(token);
      expect(allLogs).not.toContain(auth(token));
      expect(allLogs).not.toContain(auth(token).slice(6));
    }
  });
}
