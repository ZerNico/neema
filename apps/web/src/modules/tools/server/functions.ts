import { createServerFn } from "@tanstack/react-start";
import { Effect, Redacted, Schema } from "effect";
import { requireAdmin, requireSession } from "~/modules/auth/server/middleware.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { runtime } from "~/server/runtime.ts";
import {
  CreateSearchProviderInput,
  SearchProviderOrderInput,
  TestSearchProviderInput,
  UpdateDocumentParserToolInput,
  UpdateMemoryToolInput,
  UpdateUrlReaderToolInput,
  UpdateSearchProviderInput,
  UpdateWebSearchToolInput,
} from "../schema.ts";
import { ToolsRepo } from "./repo.ts";
import { SearchProviderRepo, type InvalidSearchProvider } from "./search-provider-repo.ts";
import { SearchProviders } from "./search-providers/chain.ts";
import { UrlReaderExecutor } from "./url-reader.ts";
import { WebSearchExecutor } from "./web-search.ts";

const standard = Schema.toStandardSchemaV1;

export const getMemoryTool = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() => runtime.runPromise(ToolsRepo.use((repo) => repo.getTool("memory"))));

export const updateMemoryTool = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(UpdateMemoryToolInput))
  .handler(({ data }) =>
    runtime.runPromise(
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
  .handler(() => runtime.runPromise(ToolsRepo.use((repo) => repo.getTool("web_search"))));

export const updateWebSearchTool = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(UpdateWebSearchToolInput))
  .handler(({ data }) => {
    const { enabled, ...config } = data;
    const configPatch = Object.fromEntries(
      Object.entries(config).filter(([, v]) => v !== undefined),
    );
    return runtime.runPromise(
      ToolsRepo.use((repo) =>
        repo.updateTool("web_search", {
          ...(enabled !== undefined ? { enabled } : {}),
          ...(Object.keys(configPatch).length > 0 ? { config: configPatch } : {}),
        }),
      ),
    );
  });

const badRequest = (error: InvalidSearchProvider) =>
  Effect.die(new Response(error.reason, { status: 400 }));

/**
 * Providers in order with what this process last saw of each: health is
 * process memory and belongs to one version of a provider.
 */
export const listSearchProviders = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() =>
    runtime.runPromise(
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
  .handler(({ data }) =>
    runtime.runPromise(
      SearchProviderRepo.use((repo) => repo.create(data)).pipe(
        Effect.catchTag("InvalidSearchProvider", badRequest),
      ),
    ),
  );

export const updateSearchProvider = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(UpdateSearchProviderInput))
  .handler(({ data }) =>
    runtime.runPromise(
      SearchProviderRepo.use((repo) => repo.update(data)).pipe(
        Effect.catchTag("InvalidSearchProvider", badRequest),
      ),
    ),
  );

export const deleteSearchProvider = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(Schema.Struct({ id: Schema.String })))
  .handler(({ data }) =>
    runtime.runPromise(SearchProviderRepo.use((repo) => repo.remove(data.id))),
  );

export const setSearchProviderOrder = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(SearchProviderOrderInput))
  .handler(({ data }) =>
    runtime.runPromise(
      SearchProviderRepo.use((repo) => repo.setOrder(data.ids)).pipe(
        Effect.catchTag("InvalidSearchProvider", badRequest),
      ),
    ),
  );

export const testSearchProvider = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(TestSearchProviderInput))
  .handler(({ data }) =>
    runtime.runPromise(
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
    runtime.runPromise(
      Effect.gen(function* () {
        const search = yield* (yield* WebSearchExecutor).availability();
        return { configured: search.configured, enabled: search.configured && search.enabled };
      }),
    ),
  );

export const getUrlReaderTool = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() => runtime.runPromise(ToolsRepo.use((repo) => repo.getTool("read_url"))));

export const updateUrlReaderTool = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(UpdateUrlReaderToolInput))
  .handler(({ data }) => {
    const { enabled, ...config } = data;
    const configPatch = Object.fromEntries(
      Object.entries(config).filter(([, v]) => v !== undefined),
    );
    return runtime.runPromise(
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
  .handler(() => runtime.runPromise(ToolsRepo.use((repo) => repo.getTool("office_files"))));

export const updateOfficeFilesTool = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(Schema.Struct({ enabled: Schema.Boolean })))
  .handler(({ data }) =>
    runtime.runPromise(
      ToolsRepo.use((repo) => repo.updateTool("office_files", { enabled: data.enabled })),
    ),
  );

export const getDocumentParserTool = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() => runtime.runPromise(ToolsRepo.use((repo) => repo.getTool("document_parser"))));

export const updateDocumentParserTool = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(UpdateDocumentParserToolInput))
  .handler(({ data }) => {
    const { enabled, ...config } = data;
    const configPatch = Object.fromEntries(
      Object.entries(config).filter(([, v]) => v !== undefined),
    );
    return runtime.runPromise(
      ToolsRepo.use((repo) =>
        repo.updateTool("document_parser", {
          ...(enabled !== undefined ? { enabled } : {}),
          ...(Object.keys(configPatch).length > 0 ? { config: configPatch } : {}),
        }),
      ),
    );
  });

export const getResearchAvailability = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(() =>
    runtime.runPromise(
      Effect.gen(function* () {
        const search = yield* (yield* WebSearchExecutor).availability();
        const reader = yield* (yield* UrlReaderExecutor).availability();
        const configured = search.configured && reader.configured;
        return { configured, enabled: configured && search.enabled && reader.enabled };
      }),
    ),
  );
