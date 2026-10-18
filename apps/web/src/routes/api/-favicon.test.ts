import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "./favicon.ts";

const mocks = vi.hoisted(() => ({ session: vi.fn(), fetch: vi.fn<typeof fetch>() }));
vi.mock("~/modules/auth/server/auth.ts", () => ({ sessionFromHeaders: mocks.session }));

const get = async (domain: string) => {
  const handlers = Route.options.server?.handlers;
  if (!handlers || typeof handlers === "function") throw new Error("Missing favicon handlers");
  const handler = handlers.GET;
  if (typeof handler !== "function") throw new Error("Missing favicon handler");
  const response = await handler({
    request: new Request(`http://test/api/favicon?domain=${encodeURIComponent(domain)}`),
    pathname: "/api/favicon",
    params: {},
    context: { cspNonce: "nonce" },
    next: () => {
      throw new Error("The favicon handler must answer itself");
    },
  });
  if (!(response instanceof Response)) throw new Error("Missing favicon response");
  return response;
};

beforeEach(() => {
  mocks.session.mockResolvedValue({ approved: true, session: { user: { id: "reader" } } });
  mocks.fetch.mockResolvedValue(
    new Response(new Uint8Array([137, 80]), { headers: { "content-type": "image/png" } }),
  );
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe("favicon proxy", () => {
  it("takes a label of the longest a hostname allows", async () => {
    expect((await get(`${"a".repeat(63)}.example`)).status).toBe(200);
  });

  it("asks the one upstream for a hostname and keeps the icon in the browser only", async () => {
    const response = await get("Example.COM");
    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://www.google.com/s2/favicons?domain=example.com&sz=32",
      expect.anything(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=86400");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it.each([
    "localhost",
    "example.com/path",
    "example.com:8080",
    "user@example.com",
    "-bad.example",
    `${"a".repeat(64)}.example`,
    "",
  ])("refuses %j before any fetch", async (domain) => {
    expect((await get(domain)).status).toBe(400);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("serves nothing to a browser without an approved session", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await get("example.com")).status).toBe(401);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("passes on only images", async () => {
    mocks.fetch.mockResolvedValue(
      new Response("<html>", { headers: { "content-type": "text/html" } }),
    );
    expect((await get("example.com")).status).toBe(404);
  });
});
