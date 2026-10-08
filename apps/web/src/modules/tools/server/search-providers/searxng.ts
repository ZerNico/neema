import { createHash } from "node:crypto";
import { Clock, Deferred, Duration, Effect, Exit, Fiber, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { invalidResponse, searchFailure, statusFailure } from "./http.ts";
import {
  SearchProviderError,
  type ImageHit,
  type ImageSearchRequest,
  type SearchAdapter,
  type SearchHit,
  type SearchRequest,
} from "./types.ts";

interface SearxngConnection {
  readonly baseUrl: string;
  readonly secret: Redacted.Redacted<string> | null;
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
const SearxngImages = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      title: Schema.optionalKey(Schema.String),
      img_src: Schema.optionalKey(Schema.NullOr(Schema.String)),
      thumbnail_src: Schema.optionalKey(Schema.NullOr(Schema.String)),
      // "1920 x 1080" or "1920x1080", when the engine reports one.
      resolution: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
});
const decodeImages = Schema.decodeUnknownEffect(SearxngImages);

/** SearXNG thumbnails are sometimes protocol-relative; only http(s) survives. */
const absolute = (url: string | null | undefined): string | undefined => {
  if (!url) return undefined;
  const full = url.startsWith("//") ? `https:${url}` : url;
  return /^https?:\/\//i.test(full) ? full : undefined;
};
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

/**
 * SearXNG adapter. The baseUrl is admin-controlled and MAY be local (that's
 * the point of self-hosting), so no SSRF guard applies here, only to
 * result-page fetching. Needs a scope for its `/config` cache.
 */
export const makeSearxngAdapter = Effect.gen(function* () {
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
  const configuration = (connection: SearxngConnection, base: string) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (closed) return yield* Effect.interrupt;
        const key = createHash("sha256")
          .update(
            JSON.stringify([base, connection.secret ? Redacted.value(connection.secret) : null]),
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
              if (connection.secret) req = HttpClientRequest.bearerToken(req, connection.secret);
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
    connection: SearxngConnection,
    request: SearchRequest,
  ): Effect.Effect<ReadonlyArray<SearchHit>, SearchProviderError> =>
    Effect.gen(function* () {
      const base = new URL(connection.baseUrl).href.replace(/\/+$/, "");
      // Bang selectors override the configured engine set; participation is unknown.
      const config = request.query.includes("!") ? null : yield* configuration(connection, base);
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
      if (res.status === 403) {
        return yield* searchFailure(
          "auth",
          "403 Forbidden. Is the json format enabled in settings.yml?",
        );
      }
      if (res.status !== 200) return yield* statusFailure(res.status, "");
      const json = yield* res.json;
      const decoded = yield* decodeSearxng(json).pipe(Effect.mapError(invalidResponse));
      // An empty page with every engine down is the backend failing, and a
      // caller that sees [] instead keeps searching a wall. Surface it.
      const unresponsive = decoded.unresponsive_engines ?? [];
      const failed = new Set(unresponsive.map(([engine]) => engine));
      if (decoded.results.length === 0 && engines?.every((engine) => failed.has(engine))) {
        const reasons = [...new Set(unresponsive.map(([, reason]) => reason ?? "unavailable"))];
        return yield* searchFailure(
          "unavailable",
          `search engines unavailable (${reasons.join(", ")})`,
        );
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
        Effect.fail(
          error instanceof SearchProviderError
            ? error
            : searchFailure("unavailable", String(error)),
        ),
      ),
    );

  const queryImages = (
    connection: SearxngConnection,
    request: ImageSearchRequest,
  ): Effect.Effect<ReadonlyArray<ImageHit>, SearchProviderError> =>
    Effect.gen(function* () {
      const base = new URL(connection.baseUrl).href.replace(/\/+$/, "");
      const config = yield* configuration(connection, base);
      const names = config?.engines
        .filter((engine) => engine.enabled && engine.categories.includes("images"))
        .map((engine) => engine.name);
      let req = HttpClientRequest.get(`${base}/search`).pipe(
        HttpClientRequest.setUrlParams({
          q: request.query,
          format: "json",
          ...(names?.length ? { engines: names.join(",") } : { categories: "images" }),
        }),
      );
      if (connection.secret) req = HttpClientRequest.bearerToken(req, connection.secret);
      const res = yield* httpClient.execute(req).pipe(Effect.timeout(Duration.seconds(10)));
      if (res.status !== 200) return yield* statusFailure(res.status, "");
      const decoded = yield* decodeImages(yield* res.json).pipe(Effect.mapError(invalidResponse));
      const seen = new Set<string>();
      const hits: ImageHit[] = [];
      for (const r of decoded.results) {
        const imageUrl = absolute(r.img_src);
        if (!imageUrl || seen.has(imageUrl)) continue;
        seen.add(imageUrl);
        const size = /^(\d+)\s*[x×]\s*(\d+)$/.exec(r.resolution ?? "");
        const thumbnailUrl = absolute(r.thumbnail_src);
        hits.push({
          imageUrl,
          pageUrl: r.url,
          title: r.title ?? r.url,
          ...(thumbnailUrl ? { thumbnailUrl } : {}),
          ...(size ? { width: Number(size[1]), height: Number(size[2]) } : {}),
        });
        if (hits.length >= request.maxResults) break;
      }
      return hits;
    }).pipe(
      Effect.catch((error) =>
        Effect.fail(
          error instanceof SearchProviderError
            ? error
            : searchFailure("unavailable", String(error)),
        ),
      ),
    );

  return {
    // Engines without date support are left out of a dated request.
    supports: { timeRange: true, language: true, maxResults: 20 },
    search: (provider, request) =>
      provider.settings.kind === "searxng"
        ? query({ baseUrl: provider.settings.baseUrl, secret: provider.secret }, request)
        : Effect.die(`searxng adapter given a ${provider.settings.kind} provider`),
    searchImages: (provider, request) =>
      provider.settings.kind === "searxng"
        ? queryImages({ baseUrl: provider.settings.baseUrl, secret: provider.secret }, request)
        : Effect.die(`searxng adapter given a ${provider.settings.kind} provider`),
  } satisfies SearchAdapter;
});
