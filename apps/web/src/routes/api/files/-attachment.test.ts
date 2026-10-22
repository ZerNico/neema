import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentNotAvailable } from "~/modules/attachments/errors.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { Route } from "./$attachmentId.ts";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  open: vi.fn(),
  read: vi.fn(),
}));
vi.mock("~/modules/auth/server/auth.ts", () => ({
  sessionFromHeaders: mocks.session,
}));
// The route's own effect runs, against an attachment service whose access answer the test sets.
vi.mock("~/server/runtime.ts", () => ({
  runtime: {
    runPromise: (effect: Effect.Effect<unknown, never, AttachmentService>) =>
      Effect.runPromise(
        Effect.provideService(effect, AttachmentService, {
          open: mocks.open,
          read: mocks.read,
        } as never),
      ),
  },
}));

const etag = `"a1-synthetic"`;
const file = {
  fileName: "synthetic.png",
  mediaType: "image/png",
  size: 3,
  bytes: new Uint8Array([1, 2, 3]),
};
const unavailable = () => Effect.fail(new AttachmentNotAvailable({ attachmentId: "synthetic" }));

const get = async (headers: Record<string, string> = {}) => {
  const handlers = Route.options.server?.handlers;
  if (!handlers || typeof handlers === "function") throw new Error("Missing attachment handlers");
  const handler = handlers.GET;
  if (typeof handler !== "function") throw new Error("Missing attachment handler");
  const response = await handler({
    request: new Request("http://test/api/files/synthetic", { headers }),
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
  mocks.open.mockReturnValue(Effect.succeed({ ...file, sha256: "x", bytes: Effect.die("unread") }));
  mocks.read.mockReturnValue(Effect.succeed(file));
});

describe("attachment HTTP cache policy", () => {
  it("lets the browser keep the bytes, but only to reuse after asking again", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(response.headers.get("ETag")).toBe(etag);
    expect(response.headers.get("Content-Disposition")).toMatch(/^inline;/);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("confirms a kept copy after checking access, without reading the bytes", async () => {
    const response = await get({ "If-None-Match": `W/${etag}` });
    expect(response.status).toBe(304);
    expect(response.headers.get("ETag")).toBe(etag);
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(mocks.open).toHaveBeenCalledWith({ userId: "reader", attachmentId: "synthetic" });
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("refuses a kept copy once its reader has lost access", async () => {
    mocks.open.mockReturnValue(unavailable());
    expect((await get({ "If-None-Match": etag })).status).toBe(404);
  });

  it("sends the bytes when the kept copy is another file's", async () => {
    const response = await get({ "If-None-Match": `"a1-other"` });
    expect(response.status).toBe(200);
    expect(mocks.read).toHaveBeenCalled();
  });

  it.each([null, { approved: false, session: { user: { id: "reader" } } }])(
    "does not read bytes without a currently approved session: %j",
    async (current) => {
      mocks.session.mockResolvedValue(current);
      expect((await get({ "If-None-Match": etag })).status).toBe(401);
      expect(mocks.open).not.toHaveBeenCalled();
      expect(mocks.read).not.toHaveBeenCalled();
    },
  );

  it("does not cache a missing attachment as a successful file", async () => {
    mocks.read.mockReturnValue(unavailable());
    const response = await get();
    expect(response.status).toBe(404);
    expect(response.headers.get("ETag")).toBeNull();
  });
});
