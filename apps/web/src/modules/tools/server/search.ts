import { createHash } from "node:crypto";
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Redacted,
  Schema,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

export class SearchBackendError extends Schema.TaggedError<SearchBackendError>()(
  "SearchBackendError",
  { backend: Schema.String, message: Schema.String },
) {}

export interface SearchConnection {
  readonly baseUrl: string;
  readonly secret: Redacted.Redacted<string> | null;
}

export interface SearchRequest {
  readonly query: string;
  readonly maxResults: number;
  readonly timeRange?: "day" | "month" | "year";
  readonly language?: string;
}

export interface SearchHit {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
  readonly engine?: string;
  readonly score?: number;
}

const SearxngResponse = Schema.Struct({
  // [engine, reason] pairs, e.g. ["brave", "too many requests"].
  unresponsive_engines: Schema.optionalKey(Schema.Array(Schema.Array(Schema.String))),
  results: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      title: Schema.optionalKey(Schema.String),
      content: Schema.optionalKey(Schema.NullOr(Schema.String)),
      engine: Schema.optionalKey(Schema.String),
      score: Schema.optionalKey(Schema.Number),
    }),
  ),
});

const decodeSearxng = Schema.decodeUnknownEffect(SearxngResponse);
const SearxngConfig = Schema.Struct({
  engines: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      enabled: Schema.Boolean,
      categories: Schema.Array(Schema.String),
      time_range_support: Schema.Boolean,
    }),
  ),
});
const decodeConfig = Schema.decodeUnknownEffect(SearxngConfig);

// Provider-agnostic search seam; SearXNG is the first backend. The baseUrl is
// admin-controlled and MAY be local (that's the point of self-hosting), so no
// SSRF guard applies here — only to result-page fetching.
export class SearchBackend extends Context.Service<
  SearchBackend,
  {
    readonly kind: string;
    search(
      connection: SearchConnection,
      request: SearchRequest,
    ): Effect.Effect<ReadonlyArray<SearchHit>, SearchBackendError>;
    test(connection: SearchConnection): Effect.Effect<{ resultCount: number }, SearchBackendError>;
  }
>()("chat/tools/SearchBackend") {
  static readonly searxngLayer = Layer.effect(
    SearchBackend,
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      // Service-owned, bounded across completed entries and in-flight connections.
      // Like generation-cache, producers belong to the scope and survive only while
      // a waiter owns them. Config alone has TTLs; query results remain generation-local.
      type Config = typeof SearxngConfig.Type | null;
      type Ready = { state: "ready"; value: Config; expires: number };
      type Pending = {
        state: "pending";
        result: Deferred.Deferred<Ready>;
        producer?: Fiber.Fiber<Ready>;
        waiters: number;
      };
      const cache = new Map<string, Ready | Pending>();
      const scope = yield* Effect.scope;
      let closed = false;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed = true;
          cache.clear();
        }),
      );
      const configuration = (connection: SearchConnection, base: string) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            if (closed) return yield* Effect.interrupt;
            const key = createHash("sha256")
              .update(
                JSON.stringify([
                  base,
                  connection.secret ? Redacted.value(connection.secret) : null,
                ]),
              )
              .digest("hex");
            const now = yield* Clock.currentTimeMillis;
            let cached = cache.get(key);
            if (cached?.state === "ready") {
              if (cached.expires > now) return cached.value;
              cache.delete(key);
              cached = undefined;
            }
            if (!cached && cache.size >= 16) {
              const oldest = [...cache].find(([, entry]) => entry.state === "ready");
              if (oldest) cache.delete(oldest[0]);
              // Never cancel another connection's active waiters to inspect config.
              // Unknown participation is safe: it cannot classify an empty page as outage.
              else return null;
            }
            const pending: Pending = cached ?? {
              state: "pending",
              result: Deferred.makeUnsafe<Ready>(),
              waiters: 0,
            };
            pending.waiters++;
            if (!cached) {
              cache.set(key, pending);
              const work = Effect.gen(function* () {
                const value = yield* Effect.gen(function* () {
                  let req = HttpClientRequest.get(`${base}/config`);
                  if (connection.secret)
                    req = HttpClientRequest.bearerToken(req, connection.secret);
                  const response = yield* httpClient.execute(req);
                  if (response.status !== 200) return null;
                  return yield* decodeConfig(yield* response.json);
                }).pipe(
                  Effect.timeout(Duration.seconds(3)),
                  Effect.catch(() => Effect.succeed(null)),
                );
                const completed = yield* Clock.currentTimeMillis;
                const known = value?.engines.some(
                  (engine) => engine.enabled && engine.categories.includes("general"),
                );
                return {
                  state: "ready" as const,
                  value,
                  expires: completed + (known ? 60_000 : 5_000),
                };
              });
              pending.producer = yield* Effect.forkIn(work, scope);
              pending.producer.addObserver((exit) => {
                if (cache.get(key) === pending) {
                  if (Exit.isSuccess(exit)) cache.set(key, exit.value);
                  else cache.delete(key);
                }
                Deferred.doneUnsafe(pending.result, exit);
              });
            }
            return yield* restore(Deferred.await(pending.result)).pipe(
              Effect.map((entry) => entry.value),
              Effect.ensuring(
                Effect.gen(function* () {
                  pending.waiters--;
                  if (pending.waiters === 0 && cache.get(key) === pending) {
                    cache.delete(key);
                    if (pending.producer) yield* Fiber.interrupt(pending.producer);
                  }
                }),
              ),
            );
          }),
        );

      const query = (
        connection: SearchConnection,
        request: SearchRequest,
      ): Effect.Effect<ReadonlyArray<SearchHit>, SearchBackendError> =>
        Effect.gen(function* () {
          const base = new URL(connection.baseUrl).href.replace(/\/+$/, "");
          // Bang selectors override the configured engine set; participation is unknown.
          const config = request.query.includes("!")
            ? null
            : yield* configuration(connection, base);
          const names = config?.engines
            .filter(
              (engine) =>
                engine.enabled &&
                engine.categories.includes("general") &&
                (!request.timeRange || engine.time_range_support),
            )
            .map((engine) => engine.name);
          const engines = names?.length ? names : null;
          let req = HttpClientRequest.get(`${base}/search`).pipe(
            HttpClientRequest.setUrlParams({
              q: request.query,
              format: "json",
              ...(engines ? { engines: engines.join(",") } : {}),
              ...(request.timeRange ? { time_range: request.timeRange } : {}),
              ...(request.language ? { language: request.language } : {}),
            }),
          );
          if (connection.secret) {
            req = HttpClientRequest.bearerToken(req, connection.secret);
          }
          const res = yield* httpClient.execute(req).pipe(Effect.timeout(Duration.seconds(10)));
          if (res.status !== 200) {
            return yield* new SearchBackendError({
              backend: "searxng",
              message:
                res.status === 403
                  ? "403 Forbidden — is the json format enabled in settings.yml?"
                  : `HTTP ${res.status}`,
            });
          }
          const json = yield* res.json;
          const decoded = yield* decodeSearxng(json);
          // An empty page with every engine down is the backend failing, and a
          // caller that sees [] instead keeps searching a wall. Surface it.
          const unresponsive = decoded.unresponsive_engines ?? [];
          const failed = new Set(unresponsive.map(([engine]) => engine));
          if (decoded.results.length === 0 && engines?.every((engine) => failed.has(engine))) {
            const reasons = [...new Set(unresponsive.map(([, reason]) => reason ?? "unavailable"))];
            return yield* new SearchBackendError({
              backend: "searxng",
              message: `search engines unavailable (${reasons.join(", ")})`,
            });
          }

          // Dedupe by normalized URL, keep search order, cap at maxResults.
          const seen = new Set<string>();
          const hits: SearchHit[] = [];
          for (const r of decoded.results) {
            const key = r.url.replace(/\/$/, "");
            if (seen.has(key)) continue;
            seen.add(key);
            hits.push({
              url: r.url,
              title: r.title ?? r.url,
              snippet: r.content ?? "",
              ...(r.engine !== undefined ? { engine: r.engine } : {}),
              ...(r.score !== undefined ? { score: r.score } : {}),
            });
            if (hits.length >= request.maxResults) break;
          }
          return hits;
        }).pipe(
          Effect.catch((error) =>
            error instanceof SearchBackendError
              ? Effect.fail(error)
              : Effect.fail(new SearchBackendError({ backend: "searxng", message: String(error) })),
          ),
        );

      return SearchBackend.of({
        kind: "searxng",
        search: (connection, request) => query(connection, request),
        test: (connection) =>
          Effect.map(query(connection, { query: "searxng", maxResults: 5 }), (hits) => ({
            resultCount: hits.length,
          })),
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
