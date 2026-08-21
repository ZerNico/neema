import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageBubble } from "./message-list.tsx";

describe("MessageBubble", () => {
  it("renders user content right-aligned", () => {
    render(
      <MessageBubble message={{ id: "1", role: "user", content: "Hello!", status: "complete" }} />,
    );
    expect(screen.getByText("Hello!")).toBeInTheDocument();
  });

  it("shows thinking indicator for empty streaming messages", () => {
    render(
      <MessageBubble message={{ id: "2", role: "assistant", content: "", status: "streaming" }} />,
    );
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
  });

  it("shows an error note for failed generations", () => {
    render(
      <MessageBubble
        message={{ id: "3", role: "assistant", content: "partial", status: "error" }}
      />,
    );
    expect(screen.getByText("Generation failed.")).toBeInTheDocument();
  });
});
