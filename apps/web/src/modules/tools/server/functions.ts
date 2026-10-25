import { createServerFn } from "@tanstack/react-start";
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
  ToolSettingsInput,
  UpdateScanReadingInput,
  UpdateSearchProviderInput,
  UpdateToolSettingsInput,
} from "../schema.ts";
import {
  DocumentParser,
  readVisionConnection,
} from "~/modules/attachments/server/document-parser.ts";
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

/** The built-in tools' settings rows, one per tool, without their secrets. */
export const getToolSettings = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .validator(standard(ToolSettingsInput))
  .handler(({ data }) => runServerFn(ToolsRepo.use((repo) => repo.getTool(data.tool))));

export const updateToolSettings = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(UpdateToolSettingsInput))
  .handler(({ data }) => {
    if (data.tool === "memory") return runServerFn(setMemoryEnabled(data.enabled));
    const { tool, enabled, ...config } = data;
    const configPatch = Object.fromEntries(
      Object.entries(config).filter(([, v]) => v !== undefined),
    );
    return runServerFn(
      ToolsRepo.use((repo) =>
        repo.updateTool(tool, {
          ...(enabled !== undefined ? { enabled } : {}),
          ...(Object.keys(configPatch).length > 0 ? { config: configPatch } : {}),
        }),
      ),
    );
  });

/** Open chats read the memory policy live, so a real change is announced to them. */
const setMemoryEnabled = (enabled: boolean) =>
  Effect.gen(function* () {
    const result = yield* (yield* ToolsRepo).setToolEnabled("memory", enabled);
    if (result.changed) {
      yield* (yield* SyncBus)
        .publishGlobal({ type: "memory.policy.changed" })
        .pipe(
          Effect.catchCause(() =>
            Effect.logWarning("memory policy changed but sync publication failed"),
          ),
        );
    }
    return result.tool;
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
 * Non-admin: what the composer may offer, as booleans only. Search is the
 * Search toggle, which controls web_search alone: the URL reader has no
 * toggle and is gated by URLs in user-authored messages. Research needs both.
 * Document parsing decides whether a PDF chip is usable without native file
 * support on the selected model.
 */
export const getComposerAvailability = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(() =>
    runServerFn(
      Effect.gen(function* () {
        const search = yield* (yield* WebSearchExecutor).availability();
        const reader = yield* (yield* UrlReaderExecutor).availability();
        const parser = yield* (yield* DocumentParser).availability();
        const researchConfigured = search.configured && reader.configured;
        return {
          search: { configured: search.configured, enabled: search.configured && search.enabled },
          research: {
            configured: researchConfigured,
            enabled: researchConfigured && search.enabled && reader.enabled,
          },
          documentParsing: { configured: parser.configured, enabled: parser.enabled },
        };
      }),
    ),
  );

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
        const { scans } = row.config;
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
