import { Schema, type Effect, type Redacted } from "effect";
import type { SearchProviderSettings } from "../../schema.ts";

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

export interface ImageSearchRequest {
  readonly query: string;
  readonly maxResults: number;
}

/** One image result: the picture itself and the page it appears on. */
export interface ImageHit {
  readonly imageUrl: string;
  /** A smaller copy the provider serves, preferred when present. */
  readonly thumbnailUrl?: string;
  readonly pageUrl: string;
  readonly title: string;
  readonly width?: number;
  readonly height?: number;
}

/** One configured provider as an attempt sees it: decoded settings, decrypted secret. */
export interface SearchProviderSnapshot {
  readonly id: string;
  readonly label: string;
  /** Changes on every edit, so a corrected key is not judged by the old one's failures. */
  readonly version: number;
  readonly settings: SearchProviderSettings;
  readonly secret: Redacted.Redacted<string> | null;
}

/**
 * Why an attempt failed, which decides how long the chain leaves the provider
 * at the back of the order. `rejected` is about this query, not the provider.
 */
export const SearchFailureReason = Schema.Literals([
  "unavailable",
  "rate_limited",
  "quota",
  "auth",
  "rejected",
]);
export type SearchFailureReason = typeof SearchFailureReason.Type;

export class SearchProviderError extends Schema.TaggedError<SearchProviderError>()(
  "SearchProviderError",
  {
    reason: SearchFailureReason,
    message: Schema.String,
    retryAfterMs: Schema.optionalKey(Schema.Number),
  },
) {}

export interface SearchAdapter {
  readonly supports: {
    readonly timeRange: boolean;
    readonly language: boolean;
    /** The provider's own per-request ceiling; the tool setting is capped to it. */
    readonly maxResults: number;
  };
  search(
    provider: SearchProviderSnapshot,
    request: SearchRequest,
  ): Effect.Effect<ReadonlyArray<SearchHit>, SearchProviderError>;
  /** Image search, for providers that have it. */
  searchImages?(
    provider: SearchProviderSnapshot,
    request: ImageSearchRequest,
  ): Effect.Effect<ReadonlyArray<ImageHit>, SearchProviderError>;
}
