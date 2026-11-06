import { describe, expect, it } from "vitest";
import { documentImagePath, publicDocumentImagePath } from "../schema.ts";
import { publicTree } from "./public-document.ts";

const image = (src: string) => ({ type: "image", attrs: { src, alt: "" } });

describe("publicTree", () => {
  it("loads the document's own images through the link and drops other addresses here", () => {
    const tree = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            image(documentImagePath("doc-1", "img-1")),
            image(documentImagePath("doc-2", "img-9")),
            image("https://example.com/a.png"),
          ],
        },
      ],
    };
    expect(publicTree(tree, "doc-1", "tok")).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            image(publicDocumentImagePath("tok", "img-1")),
            image("https://example.com/a.png"),
          ],
        },
      ],
    });
  });

  it("removes comment marks and keeps the rest", () => {
    const text = (marks: unknown[]) => ({ type: "text", text: "hi", marks });
    const tree = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            text([{ type: "comment", attrs: { thread: "t" } }]),
            text([{ type: "bold" }, { type: "comment", attrs: { thread: "t" } }]),
          ],
        },
      ],
    };
    expect(publicTree(tree, "doc-1", "tok")).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "hi" }, text([{ type: "bold" }])],
        },
      ],
    });
  });
});
