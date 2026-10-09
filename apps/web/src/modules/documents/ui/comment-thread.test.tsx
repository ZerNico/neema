import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentComment } from "../schema.ts";
import { CommentThread } from "./comment-thread.tsx";

const comment = (body: string): DocumentComment => ({
  id: "t1",
  threadId: "t1",
  author: { id: "u1", name: "Ada" },
  byAssistant: false,
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
});
