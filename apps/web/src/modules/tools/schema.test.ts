import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SearchProviderSettings, UpdateWebSearchToolInput, WebSearchConfig } from "./schema.ts";

const config = { maxResults: 8 };
const decodeConfig = Schema.decodeUnknownSync(WebSearchConfig);
const decodeUpdate = Schema.decodeUnknownSync(UpdateWebSearchToolInput);

describe("research search configuration", () => {
  it("keeps unrelated patches from resetting the budget", () => {
    expect(decodeConfig(config)).toEqual(config);
    expect(decodeUpdate({ enabled: false })).toEqual({ enabled: false });
  });

  it.each([12, 80, 120])(
    "accepts a %i-query budget in stored config and admin updates",
    (researchMaxSearchQueries) => {
      expect(decodeConfig({ ...config, researchMaxSearchQueries }).researchMaxSearchQueries).toBe(
        researchMaxSearchQueries,
      );
      expect(decodeUpdate({ researchMaxSearchQueries })).toEqual({ researchMaxSearchQueries });
    },
  );

  it.each([11, 121, 12.5, null, "80"])(
    "rejects invalid budget %s in both boundaries",
    (researchMaxSearchQueries) => {
      const atBudget = /\n  at \["researchMaxSearchQueries"\]$/;
      expect(() => decodeConfig({ ...config, researchMaxSearchQueries })).toThrow(atBudget);
      expect(() => decodeUpdate({ researchMaxSearchQueries })).toThrow(atBudget);
    },
  );
});

describe("search provider settings", () => {
  const decode = Schema.decodeUnknownSync(SearchProviderSettings);

  it("requires a base URL only for SearXNG", () => {
    expect(decode({ kind: "searxng", baseUrl: "http://searx" })).toEqual({
      kind: "searxng",
      baseUrl: "http://searx",
    });
    expect(() => decode({ kind: "searxng" })).toThrow(/^Missing key\n  at \["baseUrl"\]/);
    expect(decode({ kind: "tavily" })).toEqual({ kind: "tavily" });
  });

  it("keeps a hosted provider on its fixed endpoint", () => {
    expect(decode({ kind: "brave", baseUrl: "http://elsewhere" })).toEqual({ kind: "brave" });
    expect(() => decode({ kind: "bing" })).toThrow(/^Expected "tavily" \| .*\n  at \["kind"\]$/);
  });
});
