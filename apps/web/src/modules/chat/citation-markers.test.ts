import { describe, expect, it } from "vitest";
import { stripCitationMarkers, stripUndefinedCitationMarkers } from "./citation-markers.ts";

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

describe("stripUndefinedCitationMarkers", () => {
  it("removes markers with no definition (imitated citations)", () => {
    expect(stripUndefinedCitationMarkers("Effect 4 is out[^1][^2]. Done[^3].")).toBe(
      "Effect 4 is out. Done.",
    );
  });

  it("keeps markers the text defines itself (real footnotes)", () => {
    const md = "A real footnote[^1] and a fake one[^2].\n\n[^1]: the definition";
    expect(stripUndefinedCitationMarkers(md)).toBe(
      "A real footnote[^1] and a fake one.\n\n[^1]: the definition",
    );
  });

  it("drops a half-streamed trailing marker", () => {
    expect(stripUndefinedCitationMarkers("Streaming along[^1")).toBe("Streaming along");
  });
});

describe("citation markers next to ui blocks", () => {
  const block = "```ui\n<script>const re = /[^5]/;</script>\n<text>[^1]</text>\n```";

  it("leaves a ui block byte-for-byte", () => {
    expect(stripCitationMarkers(`Fact[^1].\n\n${block}`)).toBe(`Fact.\n\n${block}`);
    expect(stripUndefinedCitationMarkers(`Fact[^2].\n\n${block}`)).toBe(`Fact.\n\n${block}`);
  });
});
