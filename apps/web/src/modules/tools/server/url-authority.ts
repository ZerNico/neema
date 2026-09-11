import { canonicalUserUrl } from "./user-urls.ts";

// Mutable authority shared by web_search and read_url for one generation.
// It starts with URLs backed by user text / prior tool results, then grows as
// searches return new hits. Model-authored prose never enters this set.
export interface UrlAuthority {
  readonly seeded: boolean;
  allow(url: string): void;
  resolve(url: string): string | null;
}

export const createUrlAuthority = (seed: ReadonlyArray<string>): UrlAuthority => {
  const allowed = new Set(seed.map(canonicalUserUrl).filter((url): url is string => url !== null));
  return {
    seeded: allowed.size > 0,
    allow(url) {
      const canonical = canonicalUserUrl(url);
      if (canonical) allowed.add(canonical);
    },
    resolve(url) {
      const canonical = canonicalUserUrl(url);
      return canonical && allowed.has(canonical) ? canonical : null;
    },
  };
};
