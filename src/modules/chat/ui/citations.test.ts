import { describe, expect, it } from "vitest";
import { collectSources, prepareCitedMarkdown, stripCitationMarkers } from "./citations.ts";
import type { ToolSource } from "../client/use-message-stream.ts";

const source = (index: number, url: string): ToolSource => ({
  index,
  url,
  title: `Title ${index}`,
  snippet: "",
  read: true,
});

describe("prepareCitedMarkdown", () => {
  it("leaves content untouched when there are no sources", () => {
    expect(prepareCitedMarkdown("plain [^1] text", [])).toBe("plain [^1] text");
  });

  it("appends a definition per source so markers resolve while streaming", () => {
    const out = prepareCitedMarkdown("Effect 4 is out[^1].", [source(1, "https://effect.website")]);
    expect(out).toContain("Effect 4 is out[^1].");
    expect(out).toContain("[^1]: https://effect.website");
  });

  it("drops a half-streamed trailing marker", () => {
    const out = prepareCitedMarkdown("Released in 2026[^1", [source(1, "https://a.dev")]);
    expect(out).toContain("Released in 2026\n");
    expect(out).not.toContain("2026[^1\n");
  });

  it("closes an unterminated code fence so definitions don't land inside it", () => {
    const out = prepareCitedMarkdown("See[^1]:\n\n```ts\nconst a = 1", [
      source(1, "https://a.dev"),
    ]);
    expect(out).toBe("See[^1]:\n\n```ts\nconst a = 1\n```\n\n[^1]: https://a.dev");
  });

  it("leaves a closed code fence alone", () => {
    const out = prepareCitedMarkdown("```ts\nconst a = 1\n```\nDone[^1].", [
      source(1, "https://a.dev"),
    ]);
    expect(out).toBe("```ts\nconst a = 1\n```\nDone[^1].\n\n[^1]: https://a.dev");
  });

  it("drops markers with no matching source", () => {
    const out = prepareCitedMarkdown("Claim[^9] and claim[^1].", [source(1, "https://a.dev")]);
    expect(out).toContain("Claim and claim[^1].");
  });
});

describe("stripCitationMarkers", () => {
  it("removes markers wherever they sit", () => {
    expect(stripCitationMarkers("Fact[^1]. More[^2][^12], done[^3].")).toBe("Fact. More, done.");
  });

  it("leaves marker-free text alone", () => {
    expect(stripCitationMarkers("Nothing to see [here](https://a.dev).")).toBe(
      "Nothing to see [here](https://a.dev).",
    );
  });
});

describe("collectSources", () => {
  it("merges activities, dedupes by index and sorts", () => {
    const merged = collectSources([
      { sources: [source(2, "https://b.dev"), source(1, "https://a.dev")] },
      { sources: [source(2, "https://b.dev"), source(3, "https://c.dev")] },
      {},
    ]);
    expect(merged.map((s) => s.index)).toEqual([1, 2, 3]);
  });
});
