import { Effect, Fiber, Layer, Redacted } from "effect";
import { Prompt } from "effect/ai";
import { beforeEach, describe, expect, it, vi, type TestContext } from "vitest";
import { buildScannedPdf } from "../../../../tests/fixtures/scanned-pdf.ts";
import { AnalyticsRepo, type UsageEventInput } from "~/modules/analytics/server/repo.ts";
import { OcrModels } from "~/modules/pdf/server/ocr-models.ts";
import { createPdfRuntime, PdfWorkers, type PdfRuntime } from "~/modules/pdf/server/runtime.ts";
import { AiGateway } from "~/modules/providers/server/gateway.ts";
import {
  ProviderRepo,
  type ModelRow,
  type ProviderWithKey,
} from "~/modules/providers/server/repo.ts";
import type { ScanModelConnection } from "~/modules/tools/schema.ts";
import { ToolsRepo } from "~/modules/tools/server/repo.ts";
import { Db } from "~/server/db.ts";
import { DocumentParser } from "./document-parser.ts";
import { AttachmentRepo } from "./repo.ts";

const approved: ScanModelConnection = {
  providerId: "provider-a",
  baseUrl: "https://approved.test/v1",
  modelKey: "vision-model",
};
const requests: string[] = [];
let onRequest: (() => void) | undefined;
// The model client's Fetch reference is memoized, so keep one fake transport for this file.
vi.stubGlobal("fetch", (input: string | URL | Request) => {
  requests.push(String(input instanceof Request ? input.url : input));
  onRequest?.();
  return Promise.resolve(
    new Response(
      `data: ${JSON.stringify({
        id: "ocr-1",
        object: "chat.completion.chunk",
        created: 1,
        model: approved.modelKey,
        choices: [{ index: 0, delta: { content: "Approved transcription" } }],
      })}\n\ndata: ${JSON.stringify({
        id: "ocr-1",
        object: "chat.completion.chunk",
        created: 1,
        model: approved.modelKey,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    ),
  );
});

beforeEach(() => {
  requests.length = 0;
  onRequest = undefined;
});

const harness = (
  context: Pick<TestContext, "signal" | "onTestFinished">,
  hooks: { rendered?: () => Promise<void>; approvalRead?: () => void } = {},
) => {
  const controller = new AbortController();
  const lifetimeSignal = AbortSignal.any([context.signal, controller.signal]);
  const pending: Promise<unknown>[] = [];
  context.onTestFinished(async () => {
    controller.abort();
    await Promise.allSettled(pending);
  });
  const runEffect = <A, E>(effect: Effect.Effect<A, E>) => {
    const task = Effect.runPromise(effect, { signal: lifetimeSignal });
    pending.push(task);
    return task;
  };
  const model: ModelRow = {
    id: "vision",
    providerId: approved.providerId,
    modelKey: approved.modelKey,
    displayName: "Approved vision",
    description: null,
    type: "chat",
    defaultPriority: null,
    contextLength: null,
    embeddingDimensions: null,
    capabilities: { tools: true, vision: true, files: false, reasoning: false, imageOutput: false },
    imageFamily: null,
    imageCapabilities: null,
    imagePricing: null,
    format: null,
    metadata: null,
    pricing: { input: 1, output: 2 },
    access: "public",
    enabled: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const provider: ProviderWithKey = {
    id: approved.providerId,
    name: "Approved provider",
    preset: "custom",
    settings: {},
    baseUrl: approved.baseUrl,
    enabled: true,
    apiKey: Redacted.make("fake-key"),
    hasApiKey: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const state = { model, provider };
  const getModel = vi.fn(() => Effect.sync<ModelRow | null>(() => ({ ...state.model })));
  const getProviderWithKey = vi.fn(() =>
    Effect.sync<ProviderWithKey | null>(() => ({ ...state.provider })),
  );
  const providerLayer = Layer.succeed(
    ProviderRepo,
    Object.assign({} as ProviderRepo["Service"], {
      getModel,
      getProviderWithKey,
      setModelFormat: () => Effect.void,
    } satisfies Pick<
      ProviderRepo["Service"],
      "getModel" | "getProviderWithKey" | "setModelFormat"
    >),
  );
  const usage: UsageEventInput[] = [];
  const analytics = Layer.succeed(AnalyticsRepo, {
    record: (event: UsageEventInput) => Effect.sync(() => void usage.push(event)),
  } as AnalyticsRepo["Service"]);
  const gatewayLayer = AiGateway.layer.pipe(Layer.provide([providerLayer, analytics]));
  const cache: Record<number, string> = {};
  const saveScannedPages = vi.fn(({ pages }: { pages: Record<number, string> }) =>
    Effect.sync<void>(() => {
      Object.assign(cache, pages);
    }),
  );
  const workers = Layer.effect(
    PdfWorkers,
    Effect.acquireRelease(
      Effect.sync(() => {
        const runtime = createPdfRuntime(
          new URL("../../pdf/server/runtime-worker.ts", import.meta.url),
        );
        const wrapped: PdfRuntime = {
          ...runtime,
          run: (work, signal, options) =>
            new Promise((resolve, reject) => {
              runtime.run(work, signal, options).then((result) => {
                if (work.kind === "render")
                  Promise.resolve(hooks.rendered?.()).then(() => resolve(result), reject);
                else resolve(result);
              }, reject);
            }),
        };
        return wrapped;
      }),
      (runtime) => Effect.promise(() => runtime.close()),
    ),
  );
  const parserLayer = DocumentParser.base.pipe(
    Layer.provide([
      gatewayLayer,
      providerLayer,
      analytics,
      workers,
      Layer.succeed(ToolsRepo, {
        getDocumentParser: () =>
          Effect.succeed({
            enabled: true,
            config: {
              maxChars: 100_000,
              maxPages: 100,
              scans: { mode: "model", modelId: "vision", approved },
            },
            secret: null,
          }),
      } as ToolsRepo["Service"]),
      Layer.succeed(OcrModels, {
        ensure: () => Effect.void,
        paths: () => Effect.succeed(null),
        status: () => Effect.succeed({ state: "missing" }),
      } as OcrModels["Service"]),
      Layer.succeed(
        AttachmentRepo,
        Object.assign({} as AttachmentRepo["Service"], {
          scannedPages: () => Effect.sync(() => ({ ...cache })),
          saveScannedPages,
        } satisfies Pick<AttachmentRepo["Service"], "scannedPages" | "saveScannedPages">),
      ),
      Layer.succeed(Db, {
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              where: () =>
                Effect.sync(() => {
                  hooks.approvalRead?.();
                  return [
                    {
                      providerId: state.provider.id,
                      baseUrl: state.provider.baseUrl,
                      modelKey: state.model.modelKey,
                      capabilities: state.model.capabilities,
                      enabled: state.model.enabled,
                      providerEnabled: state.provider.enabled,
                      access: state.model.access,
                      type: state.model.type,
                    },
                  ];
                }),
            }),
          }),
        }),
      } as never),
    ]),
  );
  const run = <A, E>(f: (parser: DocumentParser["Service"]) => Effect.Effect<A, E>) =>
    runEffect(Effect.scoped(Effect.flatMap(DocumentParser, f).pipe(Effect.provide(parserLayer))));
  const generate = () =>
    runEffect(
      Effect.flatMap(AiGateway, (gateway) =>
        gateway
          .generateText({
            modelId: "vision",
            expectedConnection: approved,
            prompt: Prompt.make("Read the approved image"),
          })
          .pipe(Effect.result),
      ).pipe(Effect.provide(gatewayLayer)),
    );
  return { state, run, generate, usage, cache, saveScannedPages, getModel, getProviderWithKey };
};

const scanned = (count: number) =>
  buildScannedPdf([
    { kind: "text", text: "Cover" },
    ...Array.from({ length: count }, (_, index) => ({
      kind: "scan" as const,
      text: `Page ${index}`,
    })),
  ]);

describe("OCR approved dispatch", () => {
  it.for([
    "provider",
    "endpoint",
    "model",
    "disabled model",
    "disabled provider",
    "private",
    "no vision",
  ])(
    "refuses %s changes in the resolution that would construct the request",
    async (change, context) => {
      const h = harness(context);
      switch (change) {
        case "provider":
          h.state.provider.id = "provider-b";
          h.state.model.providerId = "provider-b";
          break;
        case "endpoint":
          h.state.provider.baseUrl = "https://unapproved.test/v1";
          break;
        case "model":
          h.state.model.modelKey = "different-model";
          break;
        case "disabled model":
          h.state.model.enabled = false;
          break;
        case "disabled provider":
          h.state.provider.enabled = false;
          break;
        case "private":
          h.state.model.access = "groups";
          break;
        case "no vision":
          h.state.model.capabilities = { ...h.state.model.capabilities, vision: false };
          break;
      }
      const result = await h.generate();
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ProviderUnreachable" } });
      expect(requests).toEqual([]);
      expect(h.getModel).toHaveBeenCalledTimes(1);
      expect(h.getProviderWithKey).toHaveBeenCalledTimes(1);
    },
  );

  it("uses the checked immutable resolution, not a second provider lookup", async (context) => {
    const h = harness(context);
    h.getProviderWithKey.mockImplementation(() =>
      Effect.sync(() => {
        const snapshot = { ...h.state.provider };
        h.state.provider.baseUrl = "https://unapproved.test/v1";
        return snapshot;
      }),
    );
    expect(await h.generate()).toMatchObject({
      _tag: "Success",
      success: { text: "Approved transcription" },
    });
    expect(requests).toEqual(["https://approved.test/v1/chat/completions"]);
    expect(h.getProviderWithKey).toHaveBeenCalledTimes(1);
  });

  it("dispatches unchanged approvals and preserves usage and cache identity", async (context) => {
    const h = harness(context);
    const bytes = await scanned(1);
    const parsed = await h.run((parser) =>
      parser.parsePdf({ bytes, fileName: "a.pdf", blobId: "blob", owner: "owner" }),
    );
    expect(parsed.text).toContain("Approved transcription");
    expect(parsed.parsedWith).toMatch(/^pdf-3\+scan:model:vision:[a-f0-9]{12}$/);
    expect(h.cache).toEqual({ 2: "Approved transcription" });
    expect(h.saveScannedPages.mock.calls[0]?.[0]).toMatchObject({
      engine: parsed.parsedWith.split("+scan:")[1],
    });
    expect(h.usage).toMatchObject([
      {
        userId: "owner",
        kind: "ocr",
        modelId: "vision",
        modelName: "Approved vision",
        inputTokens: 10,
        outputTokens: 2,
      },
    ]);
    await h.run((parser) =>
      parser.parsePdf({ bytes, fileName: "a.pdf", blobId: "blob", owner: "owner" }),
    );
    expect(requests).toHaveLength(1);
    expect(h.usage).toHaveLength(1);
  });

  it("fails closed after a connection changes during rendering", async (context) => {
    const rendered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const h = harness(context, {
      rendered: () => {
        rendered.resolve();
        return release.promise;
      },
    });
    const bytes = await scanned(1);
    const parsed = await h.run((parser) =>
      Effect.gen(function* () {
        const parse = yield* Effect.forkChild(
          parser.parsePdf({ bytes, fileName: "a.pdf", blobId: "blob", owner: "owner" }),
        );
        yield* Effect.promise(() => rendered.promise);
        h.state.provider.baseUrl = "https://unapproved.test/v1";
        release.resolve();
        return yield* Fiber.join(parse);
      }).pipe(Effect.ensuring(Effect.sync(() => release.resolve()))),
    );
    expect(parsed.skippedPages).toEqual([2]);
    expect(parsed.parsedWith).toContain("+incomplete");
    expect(requests).toEqual([]);
    expect(h.cache).toEqual({});
    expect(h.saveScannedPages).not.toHaveBeenCalled();
    expect(h.usage).toEqual([]);
  });

  it("cancels a test’s parse during rendering before it can dispatch or publish", async (context) => {
    const controller = new AbortController();
    const rendered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const h = harness(
      {
        signal: AbortSignal.any([context.signal, controller.signal]),
        onTestFinished: context.onTestFinished,
      },
      {
        rendered: () => {
          rendered.resolve();
          return release.promise;
        },
      },
    );
    const bytes = await scanned(1);
    const parse = h.run((parser) =>
      parser.parsePdf({ bytes, fileName: "a.pdf", blobId: "cancelled", owner: "owner" }),
    );
    const cancelled = expect(parse).rejects.toThrow("All fibers interrupted without error");
    try {
      await rendered.promise;
      controller.abort();
      await cancelled;
    } finally {
      release.resolve();
    }
    expect(requests).toEqual([]);
    expect(h.saveScannedPages).not.toHaveBeenCalled();
    expect(h.usage).toEqual([]);
  });

  it("rechecks each page and keeps only pages paid for under the approved connection", async (context) => {
    const h = harness(context);
    const bytes = await scanned(4);
    onRequest = () => {
      if (requests.length === 2) h.state.provider.baseUrl = "https://unapproved.test/v1";
    };
    const parsed = await h.run((parser) =>
      parser.parsePdf({ bytes, fileName: "a.pdf", blobId: "blob", owner: "owner" }),
    );
    expect(requests).toEqual([
      "https://approved.test/v1/chat/completions",
      "https://approved.test/v1/chat/completions",
    ]);
    expect(parsed.skippedPages).toEqual([4, 5]);
    expect(parsed.parsedWith).toContain("+incomplete");
    expect(h.cache).toEqual({ 2: "Approved transcription", 3: "Approved transcription" });
    expect(h.usage).toHaveLength(2);
  });

  it("fails closed for a parse that resolved approval before waiting for the blob permit", async (context) => {
    const rendered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const secondApproval = Promise.withResolvers<void>();
    let approvals = 0;
    const h = harness(context, {
      rendered: () => {
        rendered.resolve();
        return release.promise;
      },
      approvalRead: () => {
        if (++approvals === 2) secondApproval.resolve();
      },
    });
    const bytes = await scanned(1);
    await h.run((parser) =>
      Effect.gen(function* () {
        const input = { bytes, fileName: "a.pdf", blobId: "blob", owner: "owner" };
        const first = yield* Effect.forkChild(parser.parsePdf(input));
        yield* Effect.promise(() => rendered.promise);
        const second = yield* Effect.forkChild(parser.parsePdf(input));
        yield* Effect.promise(() => secondApproval.promise);
        h.state.provider.baseUrl = "https://unapproved.test/v1";
        release.resolve();
        const results = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
        expect(results.map((result) => result.skippedPages)).toEqual([[2], [2]]);
      }).pipe(Effect.ensuring(Effect.sync(() => release.resolve()))),
    );
    expect(approvals).toBe(2);
    expect(requests).toEqual([]);
    expect(h.saveScannedPages).not.toHaveBeenCalled();
    expect(h.usage).toEqual([]);
  });
});
