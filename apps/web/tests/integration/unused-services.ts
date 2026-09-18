import { Effect, Layer } from "effect";
import { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import { DocumentParser } from "~/modules/attachments/server/document-parser.ts";
import { UrlReaderExecutor } from "~/modules/tools/server/url-reader.ts";
import { ToolUnavailable, WebSearchExecutor } from "~/modules/tools/server/web-search.ts";

/**
 * Satisfy the stream engine's dependencies without allowing blob/document reads.
 */
export const FakeBlobStore = Layer.succeed(BlobStore, {
  put: () => Effect.die("no blobs in these tests"),
  get: () => Effect.die("no blobs in these tests"),
  delete: () => Effect.void,
  exists: () => Effect.succeed(false),
  deletePrefix: () => Effect.void,
});

export const FakeDocumentParser = Layer.succeed(DocumentParser, {
  parsePdf: () => Effect.die("no documents in these tests"),
  availability: () => Effect.succeed({ configured: false, enabled: false, kind: null }),
});

// Disabled tools fail with ToolUnavailable, not a defect, so tools-capable models
// degrade normally when a suite doesn't exercise web tools.
const unavailable = (tool: "web_search" | "read_url") => () =>
  Effect.fail(new ToolUnavailable({ tool, reason: "disabled" }));
export const FakeWebSearch = Layer.succeed(WebSearchExecutor, {
  researchSearchLimit: () => Effect.die("no research in these tests"),
  handler: unavailable("web_search"),
  availability: () => Effect.succeed({ configured: false, enabled: false }),
});
export const FakeUrlReader = Layer.succeed(UrlReaderExecutor, {
  handler: unavailable("read_url"),
  availability: () => Effect.succeed({ configured: false, enabled: false }),
});
