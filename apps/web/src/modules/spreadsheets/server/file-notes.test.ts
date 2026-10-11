import { describe, expect, it } from "vitest";
import { readNote } from "./file-notes.ts";

describe("notes in Excel files", () => {
  it("reads a note's author apart from its text, as Excel writes the name into it", () => {
    expect(
      readNote({ ref: "B2", author: "Jane Doe", text: "Jane Doe:\nCheck this figure" }),
    ).toEqual({ ref: "B2", entries: [{ author: "Jane Doe", text: "Check this figure" }] });
    expect(readNote({ ref: "B2", author: "", text: "  " })).toBeNull();
    // Our own notes carry no such line, so a name at the start of the text is the text's.
    expect(readNote({ ref: "B2", author: "Jane", text: "Jane: call Bob" })).toMatchObject({
      entries: [{ author: "Jane", text: "Jane: call Bob" }],
    });
  });

  it("keeps a threaded comment's text whole when its parts cannot be told apart", () => {
    const text = "[Threaded comment]\n\nSee row 4";
    expect(readNote({ ref: "B2", author: "tc={1}", text })).toEqual({
      ref: "B2",
      entries: [{ author: "", text }],
    });
  });

  it("reads a threaded comment's note form back as its comment and replies", () => {
    const text = [
      "[Threaded comment]",
      "",
      "Your version of Excel allows you to read this threaded comment; however, any edits to it will get removed if the file is opened in a newer version of Excel. Learn more: https://go.microsoft.com/fwlink/?linkid=870924",
      "",
      "Comment:",
      "    Is this right?",
      "Reply:",
      "    Yes, checked.",
      "    Twice.",
    ].join("\r\n");
    expect(
      readNote({ ref: "C3", author: "tc={6A2B1C3D-0000-4000-8000-0123456789AB}", text }),
    ).toEqual({
      ref: "C3",
      entries: [
        { author: "", text: "Is this right?" },
        { author: "", text: "Yes, checked.\nTwice." },
      ],
    });
  });
});
