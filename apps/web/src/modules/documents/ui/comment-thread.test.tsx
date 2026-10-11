import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentComment } from "../schema.ts";
import { CommentThread } from "./comment-thread.tsx";

const comment = (body: string): DocumentComment => ({
  id: "t1",
  threadId: "t1",
  author: { id: "u1", name: "Ada" },
  byAssistant: false,
  fromFile: null,
  body,
  createdAt: new Date(0).toISOString(),
  resolvedAt: null,
  quote: "the words",
  toAssistant: true,
  answered: true,
});

describe("a comment thread", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("draws a comment opening with the assistant's name as one tag and its words", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <CommentThread
        root={comment("@Assistant make this shorter")}
        replies={[]}
        anchored
        me="u1"
        actions={null}
        expanded={false}
      />,
    );
    expect(screen.getAllByText("Assistant")).toHaveLength(1);
    expect(screen.getByText(/make this shorter/)).toBeTruthy();
    expect(errors).not.toHaveBeenCalled();
  });

  it("names a file's note by the author the file gave, never as a person here", () => {
    render(
      <CommentThread
        root={{
          ...comment("Check this figure"),
          author: null,
          fromFile: { name: "Jane Doe" },
          toAssistant: false,
        }}
        replies={[
          {
            ...comment("Checked"),
            id: "r1",
            author: null,
            fromFile: { name: "" },
            toAssistant: false,
          },
        ]}
        anchored
        me="u1"
        actions={null}
        expanded={false}
      />,
    );
    expect(screen.getByText("Jane Doe")).toBeTruthy();
    expect(screen.getByText("Note")).toBeTruthy();
    expect(screen.getAllByText("from Excel")).toHaveLength(2);
  });
});
