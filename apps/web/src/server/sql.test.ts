import { Cause } from "effect";
import { describe, expect, it } from "vitest";
import { escapeLike, isUniqueViolation } from "./sql.ts";

describe("escapeLike", () => {
  it("escapes the wildcards a user's literal text may contain", () => {
    expect(escapeLike("100%_off")).toBe("100\\%\\_off");
    expect(escapeLike("back\\slash")).toBe("back\\\\slash");
    expect(escapeLike("ordinary text")).toBe("ordinary text");
  });
});

describe("isUniqueViolation", () => {
  // Both shapes reach callers depending on how deep the driver error was
  // wrapped, and either answers the same question.
  it("recognises the tagged failure the SQL client raises", () => {
    expect(isUniqueViolation({ cause: Cause.fail({ _tag: "UniqueViolation" }) })).toBe(true);
    expect(isUniqueViolation({ cause: { reason: { _tag: "UniqueViolation" } } })).toBe(true);
  });

  it("recognises the raw Postgres error under a wrapper chain", () => {
    expect(isUniqueViolation({ cause: { cause: { code: "23505" } } })).toBe(true);
    expect(isUniqueViolation({ cause: { message: "duplicate key value violates…" } })).toBe(true);
  });

  it("leaves a real fault alone rather than dressing it up as a conflict", () => {
    expect(isUniqueViolation({ cause: { code: "23503" } })).toBe(false);
    expect(isUniqueViolation(new Error("connection reset"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    // Deeper than the walk goes: unreachable rather than silently true.
    let deep: unknown = { code: "23505" };
    for (let i = 0; i < 8; i++) deep = { cause: deep };
    expect(isUniqueViolation(deep)).toBe(false);
  });
});
