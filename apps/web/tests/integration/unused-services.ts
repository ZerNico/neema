import { Effect, Layer } from "effect";
import { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import { DocumentParser } from "~/modules/attachments/server/document-parser.ts";
import { CustomToolRuntime } from "~/modules/custom-tools/server/runtime.ts";
import { IntegrationNotAvailable } from "~/modules/integrations/errors.ts";
import { IntegrationApprovals } from "~/modules/integrations/server/approvals.ts";
import { IntegrationService } from "~/modules/integrations/server/service.ts";
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
  availability: () => Effect.succeed({ configured: false, enabled: false, scanEngine: null }),
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

/**
 * The engine requires the runtime even when no module is pinned; a call here
 * means an attempt pinned custom tools the suite did not set up.
 */
export const FakeCustomToolRuntime = Layer.succeed(CustomToolRuntime, {
  inspect: () => Effect.die("no custom tool builds in these tests"),
  run: () => Effect.die("no custom tool calls in these tests"),
});

/**
 * Nobody in these suites connects an integration, so every attempt is offered
 * none; a call to anything else means a suite reached integrations unprepared.
 */
export const NoIntegrations = Layer.mergeAll(
  Layer.succeed(IntegrationService, {
    adminList: () => Effect.die("no integrations in these tests"),
    saveConfig: () => Effect.die("no integrations in these tests"),
    listForUser: () => Effect.succeed([]),
    connectApiKey: () => Effect.die("no integrations in these tests"),
    beginOAuth: () => Effect.die("no integrations in these tests"),
    completeOAuth: () => Effect.die("no integrations in these tests"),
    updatePreferences: () => Effect.die("no integrations in these tests"),
    disconnect: () => Effect.void,
    session: (_userId, integrationId) =>
      Effect.fail(new IntegrationNotAvailable({ integrationId })),
    reportAuthFailure: () => Effect.void,
    chatIntegrations: () => Effect.succeed([]),
    resolveOffer: () => Effect.succeed([]),
    permissionsFor: () => Effect.succeed({ permissions: {}, allowedInChat: [] }),
    setConversationIntegration: () => Effect.die("no integrations in these tests"),
    reserveAllowance: () => Effect.die("no integrations in these tests"),
    releaseAllowance: () => Effect.die("no integrations in these tests"),
  }),
  Layer.succeed(IntegrationApprovals, {
    request: () => Effect.die("no integrations in these tests"),
    decide: () => Effect.succeed(false),
    get: () => Effect.succeed(null),
    pending: () => Effect.succeed([]),
  }),
);
