import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "./$.ts";

const mocks = vi.hoisted(() => ({ handler: vi.fn<(request: Request) => Promise<Response>>() }));
vi.mock("~/modules/auth/server/auth.ts", () => ({
  currentAuth: async () => ({ handler: mocks.handler }),
}));

const post = async (path: string) => {
  const handlers = Route.options.server?.handlers;
  if (!handlers || typeof handlers === "function") throw new Error("Missing auth handlers");
  const handler = handlers.POST;
  if (typeof handler !== "function") throw new Error("Missing auth handler");
  const response = await handler({
    request: new Request(`http://test/api/auth${path}`, { method: "POST" }),
    pathname: "/api/auth/$",
    params: { _splat: path.slice(1) },
    context: { cspNonce: "synthetic-nonce" },
    next: () => {
      throw new Error("Auth handler must return its response");
    },
  });
  if (!(response instanceof Response)) throw new Error("Missing auth response");
  return response;
};

beforeEach(() => {
  mocks.handler.mockReset();
});

describe("sign-out", () => {
  it("drops the browser's kept files and keeps the session cookies' removal", async () => {
    const headers = new Headers();
    headers.append("Set-Cookie", "session_token=; Max-Age=0");
    headers.append("Set-Cookie", "session_data=; Max-Age=0");
    mocks.handler.mockResolvedValue(Response.json({ success: true }, { headers }));
    const response = await post("/sign-out");
    expect(response.headers.get("Clear-Site-Data")).toBe('"cache"');
    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(await response.json()).toEqual({ success: true });
  });

  it.each([
    ["a failed sign-out", "/sign-out", 401],
    ["another auth call", "/sign-in/social", 200],
  ])("leaves %s alone", async (_, path, status) => {
    mocks.handler.mockResolvedValue(new Response(null, { status }));
    expect((await post(path)).headers.get("Clear-Site-Data")).toBeNull();
  });
});
