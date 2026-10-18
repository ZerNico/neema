import { createServerFn } from "@tanstack/react-start";
import { INTERACTIVE_UI_TOOL, MAPS_TOOL } from "~/modules/genui/settings.ts";
import { Effect, Redacted, Schema } from "effect";
import { requireAdmin, requireSession } from "~/modules/auth/server/middleware.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { refuse } from "~/server/refusal.ts";
import { runServerFn } from "~/server/run-server-fn.ts";
import {
  CreateSearchProviderInput,
  SearchProviderOrderInput,
  TestScanReaderInput,
  TestSearchProviderInput,
  UpdateDocumentParserToolInput,
  UpdateScanReadingInput,
  UpdateMemoryToolInput,
  UpdateUrlReaderToolInput,
  UpdateSearchProviderInput,
  UpdateWebSearchToolInput,
} from "../schema.ts";
import { readVisionConnection } from "~/modules/attachments/server/document-parser.ts";
import { OcrModels } from "~/modules/pdf/server/ocr-models.ts";
import { mistralBaseUrl, mistralOcr } from "~/modules/pdf/server/scan-readers.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { Db } from "~/server/db.ts";
import { ToolsRepo } from "./repo.ts";
import { SearchProviderRepo } from "./search-provider-repo.ts";
import { SearchProviders } from "./search-providers/chain.ts";
import { UrlReaderExecutor } from "./url-reader.ts";
import { WebSearchExecutor } from "./web-search.ts";

const standard = Schema.toStandardSchemaV1;

export const getMemoryTool = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() => runServerFn(ToolsRepo.use((repo) => repo.getTool("memory"))));

export const updateMemoryTool = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(UpdateMemoryToolInput))
  .handler(({ data }) =>
    runServerFn(
      Effect.gen(function* () {
        const repo = yield* ToolsRepo;
        const sync = yield* SyncBus;
        const result = yield* repo.setToolEnabled("memory", data.enabled);
        if (result.changed) {
          yield* sync
            .publishGlobal({ type: "memory.policy.changed" })
            .pipe(
              Effect.catchCause(() =>
                Effect.logWarning("memory policy changed but sync publication failed"),
              ),
            );
        }
        return result.tool;
      }),
    ),
  );

export const getWebSearchTool = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() => runServerFn(ToolsRepo.use((repo) => repo.getTool("web_search"))));

export const updateWebSearchTool = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(UpdateWebSearchToolInput))
  .handler(({ data }) => {
    const { enabled, ...config } = data;
    const configPatch = Object.fromEntries(
      Object.entries(config).filter(([, v]) => v !== undefined),
    );
    return runServerFn(
      ToolsRepo.use((repo) =>
        repo.updateTool("web_search", {
          ...(enabled !== undefined ? { enabled } : {}),
          ...(Object.keys(configPatch).length > 0 ? { config: configPatch } : {}),
        }),
      ),
    );
  });

/**
 * Providers in order with what this process last saw of each: health is
 * process memory and belongs to one version of a provider.
 */
export const listSearchProviders = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() =>
    runServerFn(
      Effect.gen(function* () {
        const providers = yield* (yield* SearchProviderRepo).list();
        const health = yield* (yield* SearchProviders).status();
        return providers.map((provider) => {
          const status = health.find(
            (entry) =>
              entry.providerId === provider.id && entry.version === provider.updatedAt.getTime(),
          );
          return {
            ...provider,
            lastSuccessAt: status?.lastSuccessAt ?? null,
            lastError: status?.lastError ?? null,
            coolingDownUntil: status?.coolingDownUntil ?? null,
          };
        });
      }),
    ),
  );

export const createSearchProvider = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(CreateSearchProviderInput))
  .handler(({ data }) => runServerFn(SearchProviderRepo.use((repo) => repo.create(data))));

export const updateSearchProvider = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(UpdateSearchProviderInput))
  .handler(({ data }) => runServerFn(SearchProviderRepo.use((repo) => repo.update(data))));

export const deleteSearchProvider = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(Schema.Struct({ id: Schema.String })))
  .handler(({ data }) => runServerFn(SearchProviderRepo.use((repo) => repo.remove(data.id))));

export const setSearchProviderOrder = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(SearchProviderOrderInput))
  .handler(({ data }) => runServerFn(SearchProviderRepo.use((repo) => repo.setOrder(data.ids))));

export const testSearchProvider = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(TestSearchProviderInput))
  .handler(({ data }) =>
    runServerFn(
      Effect.gen(function* () {
        const repo = yield* SearchProviderRepo;
        const stored = data.id ? yield* repo.snapshot(data.id) : null;
        // An empty secret field tests with the stored one.
        const secret = data.secret ? Redacted.make(data.secret) : (stored?.secret ?? null);
        const started = Date.now();
        const result = yield* (yield* SearchProviders).test({
          id: data.id ?? "draft",
          label: "draft",
          version: 0,
          settings: data.settings,
          secret,
        });
        return {
          ok: true as const,
          resultCount: result.resultCount,
          latencyMs: Date.now() - started,
        };
      }).pipe(
        Effect.catchTag("SearchProviderError", (e) =>
          Effect.succeed({ ok: false as const, error: e.message }),
        ),
      ),
    ),
  );

/**
 * Non-admin: lets the composer decide whether to show the Search toggle, which
 * controls web_search only. The URL reader has no toggle and is gated separately
 * by URLs in user-authored messages, so it is deliberately not ORed in here.
 * Exposes nothing beyond booleans.
 */
export const getWebSearchAvailability = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(() =>
    runServerFn(
      Effect.gen(function* () {
        const search = yield* (yield* WebSearchExecutor).availability();
        return { configured: search.configured, enabled: search.configured && search.enabled };
      }),
    ),
  );

export const getUrlReaderTool = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() => runServerFn(ToolsRepo.use((repo) => repo.getTool("read_url"))));

export const updateUrlReaderTool = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(UpdateUrlReaderToolInput))
  .handler(({ data }) => {
    const { enabled, ...config } = data;
    const configPatch = Object.fromEntries(
      Object.entries(config).filter(([, v]) => v !== undefined),
    );
    return runServerFn(
      ToolsRepo.use((repo) =>
        repo.updateTool("read_url", {
          ...(enabled !== undefined ? { enabled } : {}),
          ...(Object.keys(configPatch).length > 0 ? { config: configPatch } : {}),
        }),
      ),
    );
  });

export const getOfficeFilesTool = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() => runServerFn(ToolsRepo.use((repo) => repo.getTool("office_files"))));

export const updateOfficeFilesTool = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(Schema.Struct({ enabled: Schema.Boolean })))
  .handler(({ data }) =>
    runServerFn(
      ToolsRepo.use((repo) => repo.updateTool("office_files", { enabled: data.enabled })),
    ),
  );

/** Map services are reached from the server and named in the reader's map: https only. */
const MapServiceUrl = Schema.String.check(
  Schema.isMaxLength(500),
  Schema.isPattern(/^https:\/\/[^\s/]+(\/\S*)?$/),
);

export const getInteractiveUiTool = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() => runServerFn(ToolsRepo.use((repo) => repo.getTool(INTERACTIVE_UI_TOOL))));

export const updateInteractiveUiTool = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(
    standard(
      Schema.Struct({
        enabled: Schema.optionalKey(Schema.Boolean),
        images: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  )
  .handler(({ data }) => {
    const { enabled, ...config } = data;
    return runServerFn(
      ToolsRepo.use((repo) =>
        repo.updateTool(INTERACTIVE_UI_TOOL, {
          ...(enabled !== undefined ? { enabled } : {}),
          ...(Object.keys(config).length > 0 ? { config } : {}),
        }),
      ),
    );
  });

export const getMapsTool = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() => runServerFn(ToolsRepo.use((repo) => repo.getTool(MAPS_TOOL))));

export const updateMapsTool = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(
    standard(
      Schema.Struct({
        enabled: Schema.optionalKey(Schema.Boolean),
        styleLight: Schema.optionalKey(MapServiceUrl),
        styleDark: Schema.optionalKey(MapServiceUrl),
        geocoder: Schema.optionalKey(MapServiceUrl),
        routing: Schema.optionalKey(MapServiceUrl),
      }),
    ),
  )
  .handler(({ data }) => {
    const { enabled, ...config } = data;
    return runServerFn(
      ToolsRepo.use((repo) =>
        repo.updateTool(MAPS_TOOL, {
          ...(enabled !== undefined ? { enabled } : {}),
          ...(Object.keys(config).length > 0 ? { config } : {}),
        }),
      ),
    );
  });

export const getDocumentParserTool = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() => runServerFn(ToolsRepo.use((repo) => repo.getTool("document_parser"))));

export const updateDocumentParserTool = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(UpdateDocumentParserToolInput))
  .handler(({ data }) => {
    const { enabled, ...config } = data;
    const configPatch = Object.fromEntries(
      Object.entries(config).filter(([, v]) => v !== undefined),
    );
    return runServerFn(
      ToolsRepo.use((repo) =>
        repo.updateTool("document_parser", {
          ...(enabled !== undefined ? { enabled } : {}),
          ...(Object.keys(configPatch).length > 0 ? { config: configPatch } : {}),
        }),
      ),
    );
  });

/**
 * How scanned pages are read, with what the admin page needs to show for it:
 * the model files' state, the vision models one could choose, and whether a
 * chosen model's connection changed since it was approved.
 */
export const getScanReading = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() =>
    runServerFn(
      Effect.gen(function* () {
        const repo = yield* ToolsRepo;
        const ocrModels = yield* OcrModels;
        const providers = yield* ProviderRepo;
        const db = yield* Db;
        const row = yield* repo.getDocumentParser();
        if (!row) return null;
        const scans = row.config.scans ?? { mode: "off" as const };
        const providerRows = yield* providers.listProviders();
        const providerName = new Map(providerRows.map((provider) => [provider.id, provider.name]));
        const visionModels = (yield* providers.listModels({ enabledOnly: true }))
          .filter(
            (model) =>
              model.type === "chat" &&
              model.access === "public" &&
              model.capabilities.vision &&
              providerRows.some((provider) => provider.id === model.providerId && provider.enabled),
          )
          .map((model) => ({
            id: model.id,
            displayName: model.displayName,
            providerName: providerName.get(model.providerId) ?? "",
          }));
        let needsApproval = false;
        if (scans.mode === "model") {
          const now = yield* readVisionConnection(db, scans.modelId);
          needsApproval =
            now === null ||
            now.providerId !== scans.approved.providerId ||
            now.baseUrl !== scans.approved.baseUrl ||
            now.modelKey !== scans.approved.modelKey;
        }
        return {
          scans:
            scans.mode === "model" ? { mode: "model" as const, modelId: scans.modelId } : scans,
          keyConfigured: row.secret !== null,
          localFiles: {
            accurate: yield* ocrModels.status("accurate"),
            fast: yield* ocrModels.status("fast"),
          },
          visionModels,
          needsApproval,
        };
      }),
    ),
  );

/**
 * Saves the scanned-pages choice. A vision model is approved as its
 * connection is now; reading on this server starts fetching its files.
 */
export const updateScanReading = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(UpdateScanReadingInput))
  .handler(({ data }) =>
    runServerFn(
      Effect.gen(function* () {
        const repo = yield* ToolsRepo;
        const db = yield* Db;
        let scans;
        if (data.scans.mode === "model") {
          const approved = yield* readVisionConnection(db, data.scans.modelId);
          if (!approved)
            return yield* refuse(400, "Choose an enabled, public model that can see images.");
          scans = { mode: "model" as const, modelId: data.scans.modelId, approved };
        } else if (data.scans.mode === "mistral") {
          const baseUrl = mistralBaseUrl(data.scans.baseUrl);
          if (!baseUrl)
            return yield* refuse(400, "Enter the OCR service’s base URL, starting with https://.");
          scans = { mode: "mistral" as const, baseUrl };
        } else scans = data.scans;
        if (
          scans.mode === "local" &&
          (yield* (yield* OcrModels).status(scans.quality)).state === "unsupported"
        )
          return yield* refuse(400, "This server’s platform can’t read scanned pages itself.");
        if (data.scans.mode === "mistral" && !data.secret?.trim()) {
          const current = yield* repo.getDocumentParser();
          if (!current?.secret) return yield* refuse(400, "Enter an API key for the OCR service.");
        }
        yield* repo.updateTool("document_parser", {
          config: { scans },
          ...(data.secret?.trim() ? { secret: data.secret.trim() } : {}),
        });
        if (scans.mode === "local") yield* (yield* OcrModels).ensure(scans.quality);
      }),
    ),
  );

/** Fetches the model files for reading scans on this server again, after a failure. */
export const retryOcrModelDownload = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(Schema.Struct({ quality: Schema.Literals(["accurate", "fast"]) })))
  .handler(({ data }) => runServerFn(OcrModels.use((models) => models.ensure(data.quality))));

/** A one-page PDF with known words, so a test reads something real and cheap. */
const samplePdf = Effect.promise(async () => {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const document = await PDFDocument.create();
  const page = document.addPage([420, 200]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText("Scanned page test", { x: 40, y: 120, size: 24, font });
  return new Uint8Array(await document.save());
});

/** Reads the sample page with the OCR service: whether the URL and key work, and how fast. */
export const testMistralOcr = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(TestScanReaderInput))
  .handler(({ data }) =>
    runServerFn(
      Effect.gen(function* () {
        const repo = yield* ToolsRepo;
        const typed = data.secret?.trim();
        const key = typed ? Redacted.make(typed) : (yield* repo.getDocumentParser())?.secret;
        if (!key) return { ok: false as const, error: "Enter an API key." };
        const baseUrl = mistralBaseUrl(data.baseUrl);
        if (!baseUrl)
          return { ok: false as const, error: "Enter a base URL starting with https://." };
        const started = Date.now();
        const result = yield* mistralOcr({ baseUrl, key, pdf: yield* samplePdf }).pipe(
          Effect.result,
        );
        if (result._tag === "Failure") return { ok: false as const, error: result.failure.reason };
        const read = result.success.pages[0]?.markdown ?? "";
        return /scanned\s+page\s+test/i.test(read)
          ? { ok: true as const, latencyMs: Date.now() - started }
          : {
              ok: false as const,
              error: "The service answered, but did not read the sample page.",
            };
      }),
    ),
  );

export const getResearchAvailability = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(() =>
    runServerFn(
      Effect.gen(function* () {
        const search = yield* (yield* WebSearchExecutor).availability();
        const reader = yield* (yield* UrlReaderExecutor).availability();
        const configured = search.configured && reader.configured;
        return { configured, enabled: configured && search.enabled && reader.enabled };
      }),
    ),
  );
