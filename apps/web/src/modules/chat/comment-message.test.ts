import { describe, expect, it } from "vitest";
import { commentMessage, readCommentMessage } from "./comment-message.ts";

describe("comment messages", () => {
  it("reads back a comment on a document's words", () => {
    const text = commentMessage("the  quarterly\nnumbers", "Round these");
    expect(text).toBe("Comment on “the quarterly numbers”: Round these");
    expect(readCommentMessage(text)).toEqual({
      quote: "the quarterly numbers",
      body: "Round these",
    });
  });

  it("names a file's reference for the model and only its name for people", () => {
    const ref = "attachment:01a14426-fdc3-7e42-8c76-bc106259172b" as const;
    const text = commentMessage("Sales!B5:C7", "Make these 4: not 3", {
      name: "Q3 (final).xlsx",
      ref,
    });
    expect(text).toBe(`Comment on “Sales!B5:C7” in Q3 (final).xlsx (${ref}): Make these 4: not 3`);
    expect(readCommentMessage(text)).toEqual({
      quote: "Sales!B5:C7",
      file: "Q3 (final).xlsx",
      body: "Make these 4: not 3",
    });
  });

  it("leaves ordinary messages alone", () => {
    expect(readCommentMessage("Comment on this please")).toBeNull();
  });
});
