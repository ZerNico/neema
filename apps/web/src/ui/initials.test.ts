import { describe, expect, it } from "vitest";

import { initials } from "./initials";

describe("initials", () => {
  it("takes the first letter of the first two words", () => {
    expect(initials("Nico Franke")).toBe("NF");
    expect(initials("ada lovelace byron")).toBe("AL");
  });

  it("uses one letter for a single word", () => {
    expect(initials("support@acme.io")).toBe("S");
  });

  it("falls back for a blank name", () => {
    expect(initials("  ")).toBe("?");
  });
});
