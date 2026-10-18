import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentService } from "~/modules/attachments/server/service.ts";
import type { DocumentService } from "~/modules/documents/server/document-service.ts";
import { parseMarkdown } from "~/modules/documents/editor/markdown.ts";
import { WordError } from "~/modules/word/errors.ts";
import type { WordProcessor } from "~/modules/word/server/runtime.ts";
import { Route } from "./$documentId.export.ts";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  read: vi.fn(),
  image: vi.fn(),
  word: vi.fn(),
}));
vi.mock("~/modules/auth/server/auth.ts", () => ({ sessionFromHeaders: mocks.session }));
// The services are the fakes: the route's access, image scoping and response are real.
vi.mock("~/server/runtime.ts", async () => {
  const { Layer } = await import("effect");
  const { DocumentService } = await import("~/modules/documents/server/document-service.ts");
  const { AttachmentService } = await import("~/modules/attachments/server/service.ts");
  const { WordProcessor } = await import("~/modules/word/server/runtime.ts");
  const services = Layer.mergeAll(
    Layer.mock(DocumentService, { read: (...args) => mocks.read(...args) }),
    Layer.mock(AttachmentService, { readDocumentImage: (input) => mocks.image(input) }),
    Layer.succeed(WordProcessor, {
      run: (...args) => mocks.word(...args),
      close: () => Promise.resolve(),
    }),
  );
  return {
    runtime: {
      runPromise: <A, E>(
        effect: Effect.Effect<A, E, DocumentService | AttachmentService | WordProcessor>,
      ) => Effect.runPromise(Effect.provide(effect, services)),
    },
  };
});

const get = async () => {
  const handlers = Route.options.server?.handlers;
  if (!handlers || typeof handlers === "function") throw new Error("Missing export handlers");
  const handler = handlers.GET;
  if (typeof handler !== "function") throw new Error("Missing export handler");
  const response = await handler({
    request: new Request("http://test/api/documents/doc-1/export"),
    pathname: "/api/documents/$documentId/export",
    params: { documentId: "doc-1" },
    context: { cspNonce: "nonce" },
    next: () => {
      throw new Error("The export handler must answer itself");
    },
  });
  if (!(response instanceof Response)) throw new Error("Missing export response");
  return response;
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ approved: true, session: { user: { id: "reader" } } });
  mocks.read.mockReturnValue(
    Effect.succeed({
      document: { id: "doc-1", title: "Plan, final" },
      doc: parseMarkdown(
        [
          "![own](/api/documents/doc-1/images/img-1)",
          "![other](/api/documents/doc-2/images/img-9)",
          "![outside](https://elsewhere.example/c.png)",
        ].join("\n\n"),
      ),
      comments: [],
    }),
  );
  mocks.image.mockReturnValue(Effect.succeed({ bytes: new Uint8Array([1, 2]) }));
  mocks.word.mockResolvedValue(new Uint8Array([80, 75]));
});

describe("document export", () => {
  it("reads only this document's own images, through this document", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(mocks.read).toHaveBeenCalledWith("reader", "doc-1");
    expect(mocks.image.mock.calls).toEqual([[{ documentId: "doc-1", attachmentId: "img-1" }]]);
    const [request, , options] = mocks.word.mock.calls[0]!;
    expect(Object.keys(request.document.images)).toEqual(["/api/documents/doc-1/images/img-1"]);
    expect(options).toEqual({ owner: "reader" });
  });

  it("downloads as a private Word file named for its title", async () => {
    const response = await get();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="document.docx"; filename*=UTF-8''Plan%2C%20final.docx`,
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([80, 75]));
  });

  it("answers 404 for a document the person may not read, building nothing", async () => {
    mocks.read.mockReturnValue(Effect.succeed(null));
    expect((await get()).status).toBe(404);
    expect(mocks.image).not.toHaveBeenCalled();
    expect(mocks.word).not.toHaveBeenCalled();
  });

  it("refuses a browser without an approved session", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("reports a document Word cannot hold as unprocessable", async () => {
    mocks.word.mockRejectedValue(new WordError("limit", "Too large."));
    const response = await get();
    expect(response.status).toBe(422);
    expect(await response.text()).toBe("Too large.");
  });
});
