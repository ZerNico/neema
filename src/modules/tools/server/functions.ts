import { createServerFn } from "@tanstack/react-start";
import { Effect, Redacted, Schema } from "effect";
import { requireAdmin, requireSession } from "~/modules/auth/server/middleware.ts";
import { runtime } from "~/server/runtime.ts";
import {
  TestSearchConnectionInput,
  UpdateDocumentParserToolInput,
  UpdateUrlReaderToolInput,
  UpdateWebSearchToolInput,
} from "../schema.ts";
import { ToolsRepo } from "./repo.ts";
import { SearchBackend } from "./search.ts";
import { UrlReaderExecutor } from "./url-reader.ts";
import { WebSearchExecutor } from "./web-search.ts";

const standard = Schema.toStandardSchemaV1;

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

// Non-admin: lets the composer decide whether to show the web toggle. One
// toggle arms whichever web tools are admin-enabled — search, the URL reader,
// or both — so this ORs their availability. Exposes nothing beyond booleans.
export const getWebSearchAvailability = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(() =>
    runtime.runPromise(
      Effect.gen(function* () {
        const search = yield* (yield* WebSearchExecutor).availability();
        const reader = yield* (yield* UrlReaderExecutor).availability();
        return {
          configured: search.configured || reader.configured,
          enabled: (search.configured && search.enabled) || (reader.configured && reader.enabled),
        };
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
