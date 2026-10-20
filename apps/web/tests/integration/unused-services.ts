import { Effect, Layer, Stream } from "effect";
import { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import { DocumentParser } from "~/modules/attachments/server/document-parser.ts";
import { CustomToolRuntime } from "~/modules/custom-tools/server/runtime.ts";
import { IntegrationNotAvailable } from "~/modules/integrations/errors.ts";
import { IntegrationApprovals } from "~/modules/integrations/server/approvals.ts";
import { IntegrationService } from "~/modules/integrations/server/service.ts";
import { KnowledgeSearch } from "~/modules/knowledge/server/search.ts";
import { KnowledgeService } from "~/modules/knowledge/server/service.ts";
import { AiGateway } from "~/modules/providers/server/gateway.ts";
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

/** Keeps bytes in `blobs`, for suites that store files and read them back. */
export const memoryBlobStore = (blobs = new Map<string, Uint8Array>()) =>
  Layer.succeed(BlobStore, {
    put: (key, bytes) => Effect.sync(() => void blobs.set(key, bytes)),
    get: (key) => Effect.succeed(blobs.get(key) ?? new Uint8Array()),
    delete: (key) => Effect.sync(() => void blobs.delete(key)),
    exists: (key) => Effect.succeed(blobs.has(key)),
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
  images: unavailable("web_search"),
  availability: () => Effect.succeed({ configured: false, enabled: false }),
});
/** Enabled search that finds nothing, so a model may call web_search and get an empty answer. */
export const EmptyWebSearch = Layer.succeed(WebSearchExecutor, {
  researchSearchLimit: () => Effect.die("no research in these tests"),
  images: () => Effect.succeed([]),
  handler: () =>
    Effect.succeed((params: { readonly queries: ReadonlyArray<string> }) =>
      Effect.succeed({
        ok: true as const,
        targets: params.queries,
        resultCount: 0,
        pagesFetched: 0,
        results: [],
        failures: [],
        sources: [],
      }),
    ),
  availability: () => Effect.succeed({ configured: true, enabled: true }),
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
    scopeOptions: () => Effect.die("no integrations in these tests"),
    directory: () => Effect.succeed([]),
    personalServers: () => Effect.succeed({ canAdd: false, servers: [] }),
    savePersonalServer: () => Effect.die("no integrations in these tests"),
    deletePersonalServer: () => Effect.die("no integrations in these tests"),
    checkOwnTools: () => Effect.die("no integrations in these tests"),
    createIntegration: () => Effect.die("no integrations in these tests"),
    deleteIntegration: () => Effect.die("no integrations in these tests"),
    beginOAuth: () => Effect.die("no integrations in these tests"),
    completeOAuth: () => Effect.die("no integrations in these tests"),
    connectOpen: () => Effect.die("no integrations in these tests"),
    checkTools: () => Effect.die("no integrations in these tests"),
    setTool: () => Effect.die("no integrations in these tests"),
    checkDueListings: () => Effect.void,
    updatePreferences: () => Effect.die("no integrations in these tests"),
    disconnect: () => Effect.void,
    session: (_userId, integrationId) =>
      Effect.fail(new IntegrationNotAvailable({ integrationId })),
    reportAuthFailure: () => Effect.void,
    reportMissingScopes: () => Effect.void,
    chatIntegrations: () => Effect.succeed([]),
    resolveOffer: () => Effect.succeed([]),
    permissionsFor: () => Effect.succeed({ permissions: {}, allowedInChat: [] }),
    setConversationIntegration: () => Effect.die("no integrations in these tests"),
    reserveAllowance: () => Effect.die("no integrations in these tests"),
    releaseAllowance: () => Effect.die("no integrations in these tests"),
  }),
  Layer.succeed(IntegrationApprovals, {
    request: () => Effect.die("no integrations in these tests"),
    elicit: () => Effect.die("no integrations in these tests"),
    answer: () => Effect.succeed(false),
    decide: () => Effect.succeed(false),
    get: () => Effect.succeed(null),
    pending: () => Effect.succeed([]),
  }),
);

/**
 * Knowledge-backed generations are exercised in knowledge.test.ts; here no
 * message carries a manifest, so the session is never opened.
 */
export const FakeKnowledge = Layer.mergeAll(
  Layer.succeed(KnowledgeSearch, {
    search: () => Effect.die("knowledge search is not part of this suite"),
    session: () => Effect.die("knowledge session is not part of this suite"),
  } as never),
  Layer.succeed(KnowledgeService, {} as never),
);

/**
 * A provider that answers nothing unless a suite scripts it. Unscripted calls
 * die, so code that grows a provider dependency fails loudly instead of
 * talking to a fake that was never asked to model it.
 */
export const fakeGateway = (script: Partial<AiGateway["Service"]> = {}) =>
  Layer.succeed(AiGateway, {
    fetchCatalog: () => Effect.succeed([]),
    probeEmbeddingDimensions: () => Effect.die("unexpected embedding dimension probe"),
    probeChatModel: () => Effect.die("unexpected model probe"),
    embed: () => Effect.die("unexpected embed call"),
    generateText: () => Effect.die("unexpected side generation"),
    streamChat: () => Stream.die("unexpected streamed generation"),
    ...script,
  });
