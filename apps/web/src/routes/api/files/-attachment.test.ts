import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "./$attachmentId.ts";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  read: vi.fn(),
}));
vi.mock("~/modules/auth/server/auth.ts", () => ({
  sessionFromHeaders: mocks.session,
}));
vi.mock("~/server/runtime.ts", () => ({
  runtime: { runPromise: mocks.read },
}));

const get = async () => {
  const handlers = Route.options.server?.handlers;
  if (!handlers || typeof handlers === "function") throw new Error("Missing attachment handlers");
  const handler = handlers.GET;
  if (typeof handler !== "function") throw new Error("Missing attachment handler");
  const response = await handler({
    request: new Request("http://test/api/files/synthetic"),
    pathname: "/api/files/$attachmentId",
    params: { attachmentId: "synthetic" },
    context: { cspNonce: "synthetic-nonce" },
    next: () => {
      throw new Error("Attachment handler must return its response");
    },
  });
  if (!(response instanceof Response)) throw new Error("Missing attachment response");
  return response;
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ approved: true, session: { user: { id: "reader" } } });
  mocks.read.mockResolvedValue({
    bytes: new Uint8Array([1, 2, 3]),
    fileName: "synthetic.png",
    mediaType: "image/png",
  });
});

describe("attachment HTTP cache policy", () => {
  it("serves stable bytes without storing revocable access", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Disposition")).toMatch(/^inline;/);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it.each([null, { approved: false, session: { user: { id: "reader" } } }])(
    "does not read bytes without a currently approved session: %j",
    async (current) => {
      mocks.session.mockResolvedValue(current);
      expect((await get()).status).toBe(401);
      expect(mocks.read).not.toHaveBeenCalled();
    },
  );

  it("does not cache a missing attachment as a successful file", async () => {
    mocks.read.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
  });
});
