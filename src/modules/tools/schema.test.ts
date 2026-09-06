import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { UpdateWebSearchToolInput, WebSearchConfig } from "./schema.ts";

const config = { backend: "searxng", baseUrl: "http://searx", maxResults: 8 };
const decodeConfig = Schema.decodeUnknownSync(WebSearchConfig);
const decodeUpdate = Schema.decodeUnknownSync(UpdateWebSearchToolInput);

describe("research search configuration", () => {
  it("accepts legacy config and keeps unrelated patches from resetting the budget", () => {
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
      expect(() => decodeConfig({ ...config, researchMaxSearchQueries })).toThrow();
      expect(() => decodeUpdate({ researchMaxSearchQueries })).toThrow();
    },
  );
});
