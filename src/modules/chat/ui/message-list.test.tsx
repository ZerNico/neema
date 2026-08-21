import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageBubble } from "./message-list.tsx";
import type { ToolActivity } from "../client/use-message-stream.ts";
import { DetailPanelProvider } from "~/ui/detail-panel.tsx";

// The panel closes on navigation; the citation tests render outside a router.
vi.mock("@tanstack/react-router", () => ({ useRouterState: () => "/chat/test" }));

describe("MessageBubble", () => {
  it("renders user content right-aligned", () => {
    render(
      <MessageBubble
        message={{
          id: "1",
          role: "user",
          content: "Hello!",
          reasoning: "",
          reasoningSeen: false,
          toolActivities: [],
          status: "complete",
        }}
      />,
    );
    expect(screen.getByText("Hello!")).toBeInTheDocument();
  });

  it("shows thinking indicator for empty streaming messages", () => {
    render(
      <MessageBubble
        message={{
          id: "2",
          role: "assistant",
          content: "",
          reasoning: "",
          reasoningSeen: false,
          toolActivities: [],
          status: "streaming",
        }}
      />,
    );
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
  });

  it("shows an error note for failed generations", () => {
    render(
      <MessageBubble
        message={{
          id: "3",
          role: "assistant",
          content: "partial",
          reasoning: "",
          reasoningSeen: false,
          toolActivities: [],
          status: "error",
        }}
      />,
    );
    expect(screen.getByText("Generation failed.")).toBeInTheDocument();
  });
});

// These pin two streamdown 2.5.0 output details we depend on: the
// `#user-content-fn-N` href a footnote reference gets, and the `data-footnotes`
// section it appends. If an upgrade changes either, these fail instead of the
// citations silently turning back into raw markdown.
describe("MessageBubble citations", () => {
  const searchActivity: ToolActivity = {
    callId: "call-1",
    name: "web_search",
    query: "effect 4",
    status: "complete",
    sources: [
      {
        index: 1,
        url: "https://effect.website/blog",
        title: "Effect 4.0 released",
        snippet: "Effect 4.0 is now available.",
        read: true,
      },
    ],
  };

  const renderCited = (content: string, status = "complete") =>
    render(
      <DetailPanelProvider>
        <MessageBubble
          message={{
            id: "cited",
            role: "assistant",
            content,
            reasoning: "",
            reasoningSeen: false,
            toolActivities: [searchActivity],
            status,
          }}
        />
      </DetailPanelProvider>,
    );

  it("renders a footnote marker as a citation chip, not literal text", () => {
    const { container } = renderCited("Effect 4.0 is out[^1].");

    expect(
      screen.getByRole("button", { name: "Source 1: Effect 4.0 released" }),
    ).toBeInTheDocument();
    expect(container.textContent).not.toContain("[^1]");
  });

  it("suppresses the generated footnotes list", () => {
    const { container } = renderCited("Effect 4.0 is out[^1].");

    expect(container.querySelector("[data-footnotes]")).toBeNull();
    expect(container.textContent).not.toContain("effect.website/blog");
  });

  it("offers the sources panel from the actions menu once complete", () => {
    renderCited("Effect 4.0 is out[^1].");
    expect(screen.getByRole("button", { name: "Message actions" })).toBeInTheDocument();
  });

  it("hides the actions row while still streaming", () => {
    renderCited("Effect 4.0 is out[^1", "streaming");
    expect(screen.queryByRole("button", { name: "Message actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });
});

describe("MessageBubble actions", () => {
  const renderPlain = (overrides: Partial<Parameters<typeof MessageBubble>[0]["message"]> = {}) =>
    render(
      <MessageBubble
        message={{
          id: "plain",
          role: "assistant",
          content: "Hello there.",
          reasoning: "",
          reasoningSeen: false,
          toolActivities: [],
          status: "complete",
          ...overrides,
        }}
      />,
    );

  it("shows copy on completed messages without sources, but no 3-dot menu", () => {
    renderPlain();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Message actions" })).toBeNull();
  });

  it("shows retry only when the message offers it", () => {
    renderPlain();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("wires the retry button to the callback", () => {
    const onRetry = vi.fn();
    renderPlain({ onRetry });
    screen.getByRole("button", { name: "Retry" }).click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("disables retry while another generation runs", () => {
    renderPlain({ onRetry: vi.fn(), retryDisabled: true });
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
  });
});
