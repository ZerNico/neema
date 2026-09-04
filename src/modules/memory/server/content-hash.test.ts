import { describe, expect, it } from "vitest";
import {
  hashMemoryContent,
  hashSourceMessageContent,
  normalizeMemoryContent,
} from "./content-hash.ts";

describe("memory content hashing", () => {
  it("normalizes Unicode, casing and whitespace for deduplication", () => {
    expect(normalizeMemoryContent("  Ｎico\n\tLIKES   Tea  ")).toBe("nico likes tea");
    expect(hashMemoryContent("Nico likes tea.")).toBe(
      hashMemoryContent("  ＮICO\nlikes\t tea?!  "),
    );
  });

  it("produces a stable SHA-256 hex digest", () => {
    expect(hashMemoryContent("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("hashes source messages exactly so edits are detectable", () => {
    expect(hashSourceMessageContent("Nico likes tea")).not.toBe(
      hashSourceMessageContent("nico likes tea"),
    );
    expect(hashSourceMessageContent("Nico likes tea")).not.toBe(
      hashSourceMessageContent("Nico  likes tea"),
    );
  });
});
