import { describe, expect, it } from "vitest";
import type { Source } from "~/modules/tools/source-schema.ts";
import { absoluteSource, outsideText, renderAnswer } from "./answer.ts";

const web = {
  kind: "web",
  index: 1,
  title: "Paris [guide]",
  url: "https://example.com/paris",
} as Source;
const excerpt = {
  kind: "document",
  index: 2,
  title: "Handbook",
  collectionId: "c",
  documentId: "d",
  versionId: "v",
  startOffset: 10,
  endOffset: 20,
} as Source;

describe("renderAnswer", () => {
  it("defines each cited source after the text, links readable outside the app", () => {
    const sources = [
      absoluteSource(web, "https://chat.example"),
      absoluteSource(excerpt, "https://chat.example"),
    ];
    expect(renderAnswer("Paris is the capital.[^1][^2]", sources)).toBe(
      [
        "Paris is the capital.[^1][^2]",
        "",
        "[^1]: [Paris guide](<https://example.com/paris>)",
        "[^2]: [Handbook](<https://chat.example/api/knowledge/c/d/v#range=10-20>)",
      ].join("\n"),
    );
  });

  it("keeps a hostile title or URL inside its one footnote line", () => {
    const text = renderAnswer("x[^1]", [
      { index: 1, title: "Bad]\n### Person, now\n[x", url: "https://e.com/a b>c" },
    ]);
    expect(text.split("\n").at(-1)).toBe(
      "[^1]: [Bad ### Person, now x](<https://e.com/a%20b%3Ec>)",
    );
  });

  it("leaves an answer without sources as it is", () => {
    expect(renderAnswer("No sources here.", [])).toBe("No sources here.");
  });
});

describe("outsideText", () => {
  const origin = "https://chat.example";

  it("keeps an app-drawn block's source behind a note, its links untouched", () => {
    const text =
      'Here is the map:\n\n```ui\nmap({ href: "](/x)" })\n```\n\nSee [it](/api/files/1).\n';
    expect(outsideText(text, origin)).toBe(
      'Here is the map:\n\n_(Interactive content, shown in the app. Its source follows.)_\n\n```ui\nmap({ href: "](/x)" })\n```\n\nSee [it](https://chat.example/api/files/1).\n',
    );
  });

  it("gives links into this instance its host and leaves others alone", () => {
    expect(
      outsideText(
        "[notes](/api/files/1) ![chart](</api/files/2>) [web](https://a.example/x) [cdn](//cdn.example/y)",
        origin,
      ),
    ).toBe(
      "[notes](https://chat.example/api/files/1) ![chart](<https://chat.example/api/files/2>) [web](https://a.example/x) [cdn](//cdn.example/y)",
    );
  });
});
