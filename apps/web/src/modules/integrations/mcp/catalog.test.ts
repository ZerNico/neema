import { describe, expect, it } from "vitest";
import { INTEGRATION_ID, integrationToolName } from "../manifest.ts";
import {
  accessFromAnnotations,
  argumentDetails,
  assignKeys,
  keyBudget,
  summarizeArguments,
} from "./catalog.ts";

describe("access from annotations", () => {
  it("trusts nothing a server leaves unsaid", () => {
    expect(accessFromAnnotations({})).toBe("destructive");
    expect(accessFromAnnotations({ readOnlyHint: false })).toBe("destructive");
    expect(accessFromAnnotations({ destructiveHint: false })).toBe("write");
    expect(accessFromAnnotations({ readOnlyHint: true, destructiveHint: true })).toBe("read");
  });
});

describe("model-facing keys", () => {
  it("keeps a clean name, cleans the rest and always fits 64 characters", () => {
    const id = "a".repeat(24);
    expect(INTEGRATION_ID.test(id)).toBe(true);
    const long = `search_${"x".repeat(80)}`;
    const keys = assignKeys(id, ["search", "get.page", "get/page", long], new Map());
    expect(keys.get("search")).toBe("search");
    // Two names that clean up alike stay apart.
    expect(keys.get("get.page")).toBe("get_page");
    expect(keys.get("get/page")).not.toBe("get_page");
    for (const key of keys.values()) {
      expect(key.length).toBeLessThanOrEqual(keyBudget(id));
      expect(integrationToolName(id, key)).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
    expect(new Set(keys.values()).size).toBe(4);
  });

  it("never renames a tool listed before, whatever the server lists beside it", () => {
    const keys = assignKeys("mcp", ["get_page", "get.page"], new Map([["get.page", "get_page"]]));
    expect(keys.get("get.page")).toBe("get_page");
    expect(keys.get("get_page")).not.toBe("get_page");
  });

  it("never gives a tool the key another account's listing holds for a different one", () => {
    // One account's server listed `a.b` as `a_b`; another's lists a tool really called `a_b`.
    const keys = assignKeys("mcp", ["a_b"], new Map([["a.b", "a_b"]]));
    expect(keys.get("a_b")).not.toBe("a_b");
  });
});

describe("approval details", () => {
  it("lists every argument, bounded, and summarizes the first few", () => {
    const args = {
      query: "budget  2026",
      limit: 5,
      filters: { owner: "me" },
      body: "x".repeat(400),
    };
    const details = argumentDetails(args);
    expect(details.map((detail) => detail.key)).toEqual(["query", "limit", "filters", "body"]);
    expect(details[2]!.value).toBe('{"owner":"me"}');
    expect(details[3]!.value.length).toBeLessThanOrEqual(300);
    expect(summarizeArguments(args)).toBe(
      'query: budget 2026 · limit: 5 · filters: {"owner":"me"}',
    );
    expect(summarizeArguments({})).toBeNull();
  });
});
