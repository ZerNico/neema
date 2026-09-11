import { describe, expect, it } from "vitest";
import { firstNameOf, greetingFor } from "./greeting.ts";

describe("firstNameOf", () => {
  it("takes the leading word of a full name", () => {
    expect(firstNameOf("Ada Lovelace")).toBe("Ada");
  });

  it("accepts a single-word handle", () => {
    expect(firstNameOf("ada")).toBe("ada");
  });

  it("ignores surrounding and repeated whitespace", () => {
    expect(firstNameOf("  Ada   Lovelace ")).toBe("Ada");
  });

  it("rejects an address", () => {
    expect(firstNameOf("ada@example.com")).toBeNull();
  });

  it("rejects an overlong identifier", () => {
    expect(firstNameOf("a".repeat(25))).toBeNull();
  });

  it("rejects empty and missing names", () => {
    expect(firstNameOf("   ")).toBeNull();
    expect(firstNameOf(null)).toBeNull();
    expect(firstNameOf(undefined)).toBeNull();
  });
});

describe("greetingFor", () => {
  it("greets by first name", () => {
    expect(greetingFor("Ada Lovelace")).toBe("What can I help with, Ada?");
  });

  it("falls back to the neutral greeting", () => {
    expect(greetingFor("ada@example.com")).toBe("What can I help with?");
  });
});
