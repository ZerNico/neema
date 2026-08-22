import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { MessageBubble } from "./message-list.tsx";
import type { ToolActivity } from "../client/use-message-stream.ts";
import type { AttachmentUploads } from "~/modules/attachments/client/use-attachment-uploads.ts";
import type { MessageAttachment } from "~/modules/attachments/schema.ts";
import { DetailPanelProvider } from "~/ui/detail-panel.tsx";

// The panel closes on navigation; the citation tests render outside a router.
vi.mock("@tanstack/react-router", () => ({ useRouterState: () => "/chat/test" }));

// The editor needs an upload handle; these tests only exercise the empty state.
const idleUploads = (): AttachmentUploads => ({
  items: [],
  attachmentIds: [],
  uploading: false,
  hasError: false,
  isFull: false,
  notice: null,
  queued: false,
  addFiles: vi.fn(),
  remove: vi.fn(),
  seed: vi.fn(),
  submit: (send) => send([]),
  cancelQueue: vi.fn(),
  markClaimed: vi.fn(),
  reset: vi.fn(),
  dismissNotice: vi.fn(),
});

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

describe("MessageBubble attachments", () => {
  const attachment = (overrides: Partial<MessageAttachment> = {}): MessageAttachment => ({
    id: "a-1",
    fileName: "notes.txt",
    size: 2048,
    mediaType: "text/plain",
    kind: "text",
    messageId: "1",
    position: 0,
    ...overrides,
  });

  const userMessage = (content: string, attachments: ReadonlyArray<MessageAttachment>) => ({
    id: "1",
    role: "user" as const,
    content,
    reasoning: "",
    reasoningSeen: false,
    toolActivities: [],
    status: "complete" as const,
    attachments,
  });

  it("links a sent attachment to the authenticated bytes route", () => {
    render(<MessageBubble message={userMessage("look at this", [attachment()])} />);

    const link = screen.getByRole("link", { name: /notes\.txt/ });
    expect(link).toHaveAttribute("href", "/api/files/a-1");
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.getByText("2 KB")).toBeInTheDocument();
    // Read-only: the composer's remove button must not appear on a sent turn.
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
  });

  it("renders an image chip with its thumbnail", () => {
    const { container } = render(
      <MessageBubble
        message={userMessage("", [
          attachment({ id: "a-img", fileName: "shot.png", mediaType: "image/png", kind: "image" }),
        ])}
      />,
    );
    // Decorative (alt=""), so it has no accessible role to query by.
    expect(container.querySelector("img")).toHaveAttribute("src", "/api/files/a-img");
  });

  it("opens an in-app preview on a plain click instead of navigating", () => {
    render(
      <MessageBubble
        message={userMessage("", [
          attachment({ id: "a-img", fileName: "shot.png", mediaType: "image/png", kind: "image" }),
        ])}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: /shot\.png/ }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByAltText("shot.png")).toHaveAttribute("src", "/api/files/a-img");
    expect(within(dialog).getByRole("link", { name: "Open original" })).toHaveAttribute(
      "href",
      "/api/files/a-img",
    );
  });

  it("draws no text bubble for an attachment-only turn", () => {
    const { container } = render(<MessageBubble message={userMessage("", [attachment()])} />);

    expect(screen.getByRole("link", { name: /notes\.txt/ })).toBeInTheDocument();
    expect(container.querySelector(".bg-primary")).toBeNull();
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
  const renderPlain = (overrides: Partial<Parameters<typeof MessageBubble>[0]["message"]> = {}) => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      ["chat-models"],
      [
        {
          id: "model-1",
          displayName: "Test Model",
          contextLength: 128_000,
          capabilities: { reasoning: false, tools: true, vision: false, files: false },
        },
      ],
    );
    queryClient.setQueryData(["tools", "web-search", "availability"], {
      configured: true,
      enabled: true,
    });
    return render(
      <QueryClientProvider client={queryClient}>
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
        />
      </QueryClientProvider>,
    );
  };

  it("shows copy on completed messages without sources, but no 3-dot menu", () => {
    renderPlain();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Message actions" })).toBeNull();
  });

  it("resolves markers against inherited sources from earlier messages", () => {
    render(
      <DetailPanelProvider>
        <MessageBubble
          message={{
            id: "follow-up",
            role: "assistant",
            content: "As covered before[^2].",
            reasoning: "",
            reasoningSeen: false,
            toolActivities: [],
            status: "complete",
            inheritedSources: [
              {
                index: 2,
                url: "https://effect.website",
                title: "Effect docs",
                snippet: "",
                read: true,
              },
              // Uncited inherited sources stay out of the chip set entirely.
              { index: 3, url: "https://other.dev", title: "Other", snippet: "", read: false },
            ],
          }}
        />
      </DetailPanelProvider>,
    );
    expect(screen.getByRole("button", { name: "Source 2: Effect docs" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Source 3: Other" })).toBeNull();
  });

  it("hides imitated citation markers on messages without sources", () => {
    const { container } = renderPlain({
      content: "Effect 4 is out[^1][^2]. In short: tighter APIs[^1].",
    });
    expect(container.textContent).not.toContain("[^");
    expect(container.textContent).toContain("Effect 4 is out. In short: tighter APIs.");
  });

  it("gives user messages copy and (when wired) retry too", () => {
    const onRetry = vi.fn();
    renderPlain({ id: "u1", role: "user", content: "hi there", onRetry });
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    screen.getByRole("button", { name: "Retry" }).click();
    expect(onRetry).toHaveBeenCalledOnce();
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

  it("offers edit only when a user message wires it", () => {
    const onEdit = vi.fn();
    renderPlain({ role: "user", onEdit });
    screen.getByRole("button", { name: "Edit" }).click();
    expect(onEdit).toHaveBeenCalledOnce();
  });

  it("renders the controlled inline editor and wires its actions", () => {
    const onDraftChange = vi.fn();
    const onSave = vi.fn();
    const onCancel = vi.fn();
    renderPlain({
      role: "user",
      editState: {
        draft: "updated message",
        onDraftChange,
        onSave,
        onCancel,
        saveDisabled: false,
        controlsDisabled: false,
        modelId: "model-1",
        onModelChange: vi.fn(),
        searchEnabled: false,
        onSearchEnabledChange: vi.fn(),
        attachments: idleUploads(),
      },
    });

    const editor = screen.getByRole("textbox");
    expect(editor).toHaveValue("updated message");
    fireEvent.change(editor, { target: { value: "new draft" } });
    expect(onDraftChange).toHaveBeenCalledWith("new draft");
    expect(screen.getByRole("button", { name: "Add attachment" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search the web" })).toBeInTheDocument();
    expect(screen.getByText("Test Model")).toBeInTheDocument();
    screen.getByRole("button", { name: "Save edit" }).click();
    screen.getByRole("button", { name: "Cancel" }).click();
    expect(onSave).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("disables Save for an empty edit draft", () => {
    renderPlain({
      role: "user",
      editState: {
        draft: "   ",
        onDraftChange: vi.fn(),
        onSave: vi.fn(),
        onCancel: vi.fn(),
        saveDisabled: false,
        controlsDisabled: false,
        modelId: "model-1",
        onModelChange: vi.fn(),
        searchEnabled: false,
        onSearchEnabledChange: vi.fn(),
        attachments: idleUploads(),
      },
    });
    expect(screen.getByRole("button", { name: "Save edit" })).toBeDisabled();
  });

  it("shows the edited indicator only when editedAt is set", () => {
    const { rerender } = renderPlain({ role: "user", editedAt: null });
    expect(screen.queryByText("edited")).toBeNull();

    rerender(
      <MessageBubble
        message={{
          id: "edited",
          role: "user",
          content: "Hello there.",
          reasoning: "",
          reasoningSeen: false,
          toolActivities: [],
          status: "complete",
          editedAt: new Date(),
        }}
      />,
    );
    expect(screen.getByText("edited")).toBeInTheDocument();
  });
});
