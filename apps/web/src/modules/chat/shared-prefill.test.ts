import { describe, expect, it } from "vitest";
import { sharedPrefill } from "./shared-prefill.ts";

describe("sharedPrefill", () => {
  it("joins a browser's title and address", () => {
    expect(sharedPrefill({ title: "Lisbon guide", url: "https://example.com/lisbon" })).toBe(
      "Lisbon guide\n\nhttps://example.com/lisbon",
    );
  });

  it("does not repeat an address or title the text already holds", () => {
    expect(
      sharedPrefill({
        title: "Lisbon guide",
        text: "Lisbon guide https://example.com/lisbon",
        url: "https://example.com/lisbon",
      }),
    ).toBe("Lisbon guide https://example.com/lisbon");
  });

  it("is nothing when nothing was shared", () => {
    expect(sharedPrefill({ title: " ", text: "" })).toBeNull();
  });

  it("cuts a long share to what a draft holds", () => {
    const draft = sharedPrefill({ text: "a".repeat(5_000) });
    expect(draft).toHaveLength(2_000);
    expect(draft?.endsWith("…")).toBe(true);
  });
});
