import { createServerFn } from "@tanstack/react-start";
import { Effect, Redacted, Schema } from "effect";
import { requireAdmin, requireSession } from "~/modules/auth/server/middleware.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { runtime } from "~/server/runtime.ts";
import {
  TestSearchConnectionInput,
  UpdateDocumentParserToolInput,
  UpdateMemoryToolInput,
  UpdateUrlReaderToolInput,
  UpdateWebSearchToolInput,
} from "../schema.ts";
import { ToolsRepo } from "./repo.ts";
import { SearchBackend } from "./search.ts";
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
    const { enabled, secret, clearSecret, ...config } = data;
    const configPatch = Object.fromEntries(
      Object.entries(config).filter(([, v]) => v !== undefined),
    );
    return runtime.runPromise(
      ToolsRepo.use((repo) =>
        repo.updateTool("web_search", {
          ...(enabled !== undefined ? { enabled } : {}),
          ...(Object.keys(configPatch).length > 0 ? { config: configPatch } : {}),
          // empty string = keep the existing secret
          ...(secret ? { secret } : {}),
          ...(clearSecret ? { clearSecret } : {}),
        }),
      ),
    );
  });

export const testSearchConnection = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(TestSearchConnectionInput))
  .handler(({ data }) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const backend = yield* SearchBackend;
        const repo = yield* ToolsRepo;
        // Empty secret field = test with the stored secret (if any).
        const secret = data.secret
          ? Redacted.make(data.secret)
          : ((yield* repo.getWebSearch())?.secret ?? null);
        const started = Date.now();
        const result = yield* backend.test({ baseUrl: data.baseUrl, secret });
        return {
          ok: true as const,
          resultCount: result.resultCount,
          latencyMs: Date.now() - started,
        };
      }).pipe(
        Effect.catchTag("SearchBackendError", (e) =>
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
