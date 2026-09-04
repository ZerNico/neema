import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    targets: ["effect 4"],
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
          providerName: "Anthropic",
          contextLength: 128_000,
          capabilities: { reasoning: false, tools: true, vision: false, files: false },
        },
        {
          id: "model-2",
          displayName: "Other Model",
          providerName: "OpenAI",
          contextLength: 1_000_000,
          capabilities: { reasoning: true, tools: false, vision: true, files: false },
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

  it("shows branch off only when the message wires it", () => {
    renderPlain();
    expect(screen.queryByRole("button", { name: "Branch off" })).toBeNull();
  });

  it("wires the branch button to the callback", () => {
    const onBranch = vi.fn();
    renderPlain({ onBranch });
    screen.getByRole("button", { name: "Branch off" }).click();
    expect(onBranch).toHaveBeenCalledOnce();
  });

  it("keeps branching off user messages — only an answer can be forked", () => {
    renderPlain({ role: "user", content: "hi there", onBranch: vi.fn() });
    expect(screen.queryByRole("button", { name: "Branch off" })).toBeNull();
  });

  it("hides the whole action row, branching included, while the answer streams", () => {
    renderPlain({ status: "streaming", content: "half an ans", onBranch: vi.fn() });
    expect(screen.queryByRole("button", { name: "Branch off" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });

  it("disables branching while another mutation runs", () => {
    renderPlain({ onBranch: vi.fn(), branchDisabled: true });
    expect(screen.getByRole("button", { name: "Branch off" })).toBeDisabled();
  });

  it("orders the actions copy, branch off, retry", () => {
    renderPlain({ onBranch: vi.fn(), onRetry: vi.fn() });
    expect(
      screen.getAllByRole("button").map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Copy", "Branch off", "Retry"]);
  });

  it("retries immediately only when no model switch is wired", () => {
    const onRetry = vi.fn();
    renderPlain({ onRetry });
    // Plain button, no menu: the click IS the retry.
    expect(screen.queryByRole("combobox", { name: "Retry" })).toBeNull();
    screen.getByRole("button", { name: "Retry" }).click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("opens the retry menu instead of retrying when models are on offer", async () => {
    const onRetry = vi.fn();
    const onRetryWith = vi.fn();
    renderPlain({ onRetry, onRetryWith, retryModelId: "model-1" });

    screen.getByRole("combobox", { name: "Retry" }).click();
    await screen.findByRole("button", { name: /Retry same/ });
    // Opening the menu alone must not regenerate anything.
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("retries with the same model from the pinned menu row", async () => {
    const onRetry = vi.fn();
    const onRetryWith = vi.fn();
    renderPlain({ onRetry, onRetryWith, retryModelId: "model-1" });

    screen.getByRole("combobox", { name: "Retry" }).click();
    (await screen.findByRole("button", { name: /Retry same/ })).click();

    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetryWith).not.toHaveBeenCalled();
    // The row dismisses the menu like a model pick would (after its exit
    // animation).
    await waitFor(() => expect(screen.queryByRole("button", { name: /Retry same/ })).toBeNull());
  });

  it("picks a different model from the retry menu", async () => {
    const onRetry = vi.fn();
    const onRetryWith = vi.fn();
    renderPlain({ onRetry, onRetryWith, retryModelId: "model-1" });

    screen.getByRole("combobox", { name: "Retry" }).click();

    // The model that wrote the answer is marked, so "same again" is visible.
    const current = await screen.findByRole("option", { name: /Test Model/ });
    expect(current).toHaveAttribute("aria-selected", "true");

    const other = screen.getByRole("option", { name: /Other Model/ });
    expect(other).toHaveAttribute("aria-selected", "false");
    other.click();

    expect(onRetryWith).toHaveBeenCalledWith("model-2");
    // Switching models is its own path; the same-model retry must not fire.
    expect(onRetry).not.toHaveBeenCalled();
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
  it("renders the send time as a machine-readable <time> element", () => {
    const { container } = renderPlain({
      time: {
        iso: "2026-08-22T12:32:00.000Z",
        clock: "14:32",
        absolute: "Saturday 22 August 2026 at 14:32",
      },
    });
    const stamp = container.querySelector("time");
    expect(stamp).toHaveAttribute("datetime", "2026-08-22T12:32:00.000Z");
    expect(stamp).toHaveTextContent("14:32");
  });

  it("draws no timestamp before hydration has supplied one", () => {
    const { container } = renderPlain();
    expect(container.querySelector("time")).toBeNull();
  });

  it("puts the time after the actions on answers, before them on questions", () => {
    const time = {
      iso: "2026-08-22T12:32:00.000Z",
      clock: "14:32",
      absolute: "Saturday 22 August 2026 at 14:32",
    };

    const assistant = renderPlain({ time, onRetry: vi.fn() });
    const answerRow = assistant.container.querySelector("time")!.parentElement!;
    expect(answerRow.lastElementChild?.tagName).toBe("TIME");
    assistant.unmount();

    // The user row is right-aligned, so it reads inward: time, then actions.
    const user = renderPlain({ role: "user", content: "hi", time, onEdit: vi.fn() });
    const questionRow = user.container.querySelector("time")!.parentElement!;
    expect(questionRow.firstElementChild?.tagName).toBe("TIME");
  });

  it("heads a message that opens a new day, and only that one", () => {
    const { container, rerender } = renderPlain({ dayLabel: "Yesterday" });
    expect(screen.getByRole("separator", { name: "Yesterday" })).toBeInTheDocument();

    rerender(
      <MessageBubble
        message={{
          id: "plain",
          role: "assistant",
          content: "Hello there.",
          reasoning: "",
          reasoningSeen: false,
          toolActivities: [],
          status: "complete",
          dayLabel: null,
        }}
      />,
    );
    expect(container.querySelector("[role='separator']")).toBeNull();
  });

  it("collapses the compaction summary behind a trigger, and expands it on click", async () => {
    renderPlain({
      compactionActivities: [
        {
          eventId: "compact-1",
          beforeTurnIndex: 0,
          passIndex: 0,
          scope: "history",
          status: "complete",
          outcome: "summary",
          summary: "Nico wants the ledger left append-only.",
        },
      ],
    });

    const trigger = screen.getByRole("button", { name: "Earlier context summarized" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/append-only/)).toBeNull();

    fireEvent.click(trigger);
    expect(await screen.findByText(/append-only/)).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("draws no compaction activity when none occurred", () => {
    renderPlain();
    expect(screen.queryByRole("button", { name: "Earlier context summarized" })).toBeNull();
  });

  it("announces a running compaction instead of the thinking placeholder", () => {
    renderPlain({
      content: "",
      status: "streaming",
      compactionActivities: [
        {
          eventId: "compact-running",
          beforeTurnIndex: 0,
          passIndex: 0,
          scope: "history",
          status: "running",
        },
      ],
    });

    expect(screen.getByText("Summarizing earlier context…")).toBeInTheDocument();
    expect(screen.queryByText("Thinking…")).toBeNull();
    // Nothing to expand yet — a dead button would just be noise.
    expect(screen.queryByRole("button", { name: /Summarizing/ })).toBeNull();
  });

  it("expands the summary of a compaction that finished mid-generation", async () => {
    renderPlain({
      content: "",
      status: "streaming",
      compactionActivities: [
        {
          eventId: "compact-complete",
          beforeTurnIndex: 1,
          passIndex: 0,
          scope: "active_rounds",
          status: "complete",
          outcome: "summary",
          summary: "Nico wants the ledger append-only.",
        },
      ],
    });

    const trigger = screen.getByRole("button", { name: "Earlier context summarized" });
    expect(screen.queryByText(/append-only/)).toBeNull();

    fireEvent.click(trigger);
    expect(await screen.findByText(/append-only/)).toBeInTheDocument();
  });

  it("keeps a completed search collapsed when a later turn starts reading", () => {
    renderPlain({
      status: "streaming",
      content: "",
      toolActivities: [
        {
          callId: "search-1",
          name: "web_search",
          turnIndex: 0,
          callIndex: 0,
          targets: ["effect"],
          status: "complete",
          resultCount: 1,
          sources: [
            {
              index: 1,
              url: "https://effect.website/search-result",
              title: "Search-only result",
              snippet: "Search snippet",
              read: false,
            },
          ],
        },
        {
          callId: "read-1",
          name: "read_url",
          turnIndex: 1,
          callIndex: 0,
          targets: ["https://effect.website/search-result"],
          status: "running",
          pages: [
            {
              url: "https://effect.website/search-result",
              title: "Reading this page",
              status: "reading",
            },
          ],
        },
      ],
    });

    expect(screen.getByRole("button", { name: /Searched the web/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: /Reading pages/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.queryByText("Search-only result")).not.toBeInTheDocument();
    expect(screen.getByText("Reading this page")).toBeInTheDocument();
  });

  it("keeps parallel calls from the same model turn in one block", () => {
    renderPlain({
      status: "streaming",
      content: "",
      toolActivities: [
        {
          callId: "search-1",
          name: "web_search",
          turnIndex: 0,
          callIndex: 0,
          targets: ["effect"],
          status: "complete",
        },
        {
          callId: "read-1",
          name: "read_url",
          turnIndex: 0,
          callIndex: 1,
          targets: ["https://effect.website"],
          status: "running",
        },
      ],
    });

    expect(screen.getAllByRole("button", { name: /Searching the web/ })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Searched the web/ })).toBeNull();
  });

  it("orders tool, compaction, then later tool by model turn", () => {
    renderPlain({
      toolActivities: [
        {
          callId: "search-1",
          name: "web_search",
          turnIndex: 0,
          callIndex: 0,
          targets: ["effect"],
          status: "complete",
        },
        {
          callId: "read-1",
          name: "read_url",
          turnIndex: 1,
          callIndex: 0,
          targets: ["https://example.com"],
          status: "complete",
        },
      ],
      compactionActivities: [
        {
          eventId: "compact-between",
          beforeTurnIndex: 1,
          passIndex: 0,
          scope: "active_rounds",
          status: "complete",
          outcome: "summary",
          summary: "The search found relevant evidence.",
        },
      ],
    });

    const search = screen.getByRole("button", { name: /Searched the web/ });
    const compact = screen.getByRole("button", { name: "Earlier context summarized" });
    const read = screen.getByRole("button", { name: /Read pages/ });
    expect(search.compareDocumentPosition(compact) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(compact.compareDocumentPosition(read) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("labels a successful hard truncation without calling it a summary", () => {
    renderPlain({
      compactionActivities: [
        {
          eventId: "compact-truncated",
          beforeTurnIndex: 1,
          passIndex: 0,
          scope: "active_rounds",
          status: "complete",
          outcome: "hard_truncation",
        },
      ],
    });
    expect(screen.getByText("Earlier context truncated")).toBeInTheDocument();
  });

  it("says so when compaction failed and the transcript was truncated instead", () => {
    renderPlain({
      content: "",
      status: "streaming",
      compactionActivities: [
        {
          eventId: "compact-failed",
          beforeTurnIndex: 0,
          passIndex: 0,
          scope: "history",
          status: "failed",
        },
      ],
    });

    expect(screen.getByText("Couldn't summarize earlier context")).toBeInTheDocument();
  });
});
