import { Context, Duration, Effect, Layer, Redacted, Schema } from "effect";
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

      const query = (
        connection: SearchConnection,
        request: SearchRequest,
      ): Effect.Effect<ReadonlyArray<SearchHit>, SearchBackendError> =>
        Effect.gen(function* () {
          const base = connection.baseUrl.replace(/\/$/, "");
          let req = HttpClientRequest.get(`${base}/search`).pipe(
            HttpClientRequest.setUrlParams({
              q: request.query,
              format: "json",
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
