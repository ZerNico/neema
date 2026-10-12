import { EventEmitter } from "node:events";
import type { Session } from "electron";
import { afterEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("electron", () => ({ net: native }));
import { fetchManual } from "./fetch.ts";
import { fetchAllowed, receiveBytes } from "./receive.ts";

const fixture = () => {
  const profileBoundary: unknown = {};
  const profile = profileBoundary as Session;
  const request = Object.assign(new EventEmitter(), {
    end: vi.fn(),
    abort: vi.fn(),
    followRedirect: vi.fn(),
  });
  native.request.mockReturnValue(request);
  const controller = new AbortController();
  const pending = fetchManual(profile, "https://a.test/file", controller.signal, 8);
  const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} });
  return { profile, request, controller, pending, response };
};

afterEach(() => vi.clearAllMocks());

it("exposes a redirect without following and uses only the supplied session credentials", async () => {
  const { profile, request, controller, pending } = fixture();
  const receiving = fetchAllowed(
    "https://a.test/file",
    () => pending,
    (url) => url.startsWith("https://a.test/"),
    controller.signal,
  );
  request.emit("redirect", 302, "GET", "https://b.test/file", {});
  await expect(receiving).rejects.toThrow("not allowed");
  expect(native.request).toHaveBeenCalledExactlyOnceWith({
    url: "https://a.test/file",
    session: profile,
    credentials: "include",
    redirect: "manual",
  });
  expect(request.followRedirect).not.toHaveBeenCalled();
  expect(request.abort).toHaveBeenCalledOnce();
});

it("cancels an unresponsive request before response headers", async () => {
  const { request, controller, pending, response } = fixture();
  const rejected = expect(pending).rejects.toThrow("retired");
  controller.abort(new Error("retired"));
  await rejected;
  expect(request.abort).toHaveBeenCalledOnce();
  request.emit("response", response);
  response.emit("error", new Error("late response abort"));
  request.emit("error", new Error("late native abort"));
});

it("cancellation errors an active body and ignores late chunks", async () => {
  const { request, controller, pending, response } = fixture();
  request.emit("response", response);
  const reader = (await pending).body!.getReader();
  response.emit("data", Buffer.from([1, 2, 3]));
  expect([...(await reader.read()).value!]).toEqual([1, 2, 3]);
  const rejected = expect(reader.read()).rejects.toThrow("retired");
  controller.abort(new Error("retired"));
  await rejected;
  response.emit("data", Buffer.alloc(1));
  response.emit("end");
  expect(request.abort).toHaveBeenCalledOnce();
});

it("bounds the native producer before overflow can queue and cancels reader-owned bodies", async () => {
  const { request, controller, pending, response } = fixture();
  request.emit("response", response);
  const receiving = receiveBytes(await pending, 8, controller.signal);
  response.emit("data", Buffer.alloc(8));
  response.emit("data", Buffer.alloc(1));
  await expect(receiving).rejects.toThrow("too large");
  expect(request.abort).toHaveBeenCalledOnce();
  const next = fixture();
  next.request.emit("response", next.response);
  await (await next.pending).body!.cancel();
  expect(next.request.abort).toHaveBeenCalledOnce();
});

it("refuses declared overflow before creating a body", async () => {
  const { request, pending, response } = fixture();
  response.headers = { "content-length": "9" };
  const rejected = expect(pending).rejects.toThrow("too large");
  request.emit("response", response);
  await rejected;
  expect(request.abort).toHaveBeenCalledOnce();
});
