import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  SearchProviderSettings,
  ToolSettingsInput,
  UpdateToolSettingsInput,
  UpdateWebSearchToolInput,
  WebSearchConfig,
} from "./schema.ts";

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

describe("tool settings", () => {
  const decodeSettings = Schema.decodeUnknownSync(UpdateToolSettingsInput);

  it("validates each write against its own tool's fields", () => {
    expect(decodeSettings({ tool: "read_url", perPageCharCap: 15000 })).toEqual({
      tool: "read_url",
      perPageCharCap: 15000,
    });
    expect(() => decodeSettings({ tool: "maps", routing: "http://osrm.example.org" })).toThrow(
      /at \["routing"\]$/,
    );
    expect(() => decodeSettings({ tool: "memory" })).toThrow(/^Missing key\n  at \["enabled"\]$/);
  });

  // Knowledge search changes only with its embedding space, which this call cannot see.
  it("offers no write or read of knowledge search", () => {
    expect(() => decodeSettings({ tool: "knowledge_search", enabled: false })).toThrow(
      /^Expected \{ readonly "tool": "memory"/,
    );
    expect(() => Schema.decodeUnknownSync(ToolSettingsInput)({ tool: "knowledge_search" })).toThrow(
      /^Expected "memory" \| .*\n  at \["tool"\]$/,
    );
  });
});
