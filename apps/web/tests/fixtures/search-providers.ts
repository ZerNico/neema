import { Effect } from "effect";
import { SearchProviders } from "~/modules/tools/server/search-providers/chain.ts";
import type { SearchProviderSnapshot } from "~/modules/tools/server/search-providers/types.ts";

/** One enabled provider, enough for the executor to offer web_search. */
export const testSearchProvider: SearchProviderSnapshot = {
  id: "test-provider",
  label: "Test",
  version: 0,
  settings: { kind: "searxng", baseUrl: "http://localhost:8081" },
  secret: null,
};

/** A chain whose search is the test's; everything else is inert. */
export const fakeSearchProviders = (fake: Pick<SearchProviders["Service"], "search">) =>
  SearchProviders.of({
    search: fake.search,
    test: () => Effect.succeed({ resultCount: 0 }),
    status: () => Effect.succeed([]),
  });
