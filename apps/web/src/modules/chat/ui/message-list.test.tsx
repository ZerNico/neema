import { RESPONSE_FAILURES } from "../generation-failure.ts";
import {
  act,
  fireEvent,
  render as renderUnwrapped,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBubble, type DisplayMessage } from "./message-list.tsx";
import { PLACED_CALL_PREFIX, withLiveText } from "./live-message.ts";
import { createLiveText, type LiveTextSnapshot } from "../client/live-text.ts";
import { inheritSources } from "./inherited-sources.ts";
import { WritableChatProjectProvider } from "~/modules/projects/ui/save-to-project.tsx";
import { ALL_CAPABILITIES } from "~/modules/groups/policy.ts";
import type { ToolActivity, ToolSource } from "../client/use-message-stream.ts";
import type { AttachmentUploads } from "~/modules/attachments/client/use-attachment-uploads.ts";
import type { MessageAttachment } from "~/modules/attachments/schema.ts";
import { DetailPanelProvider, DetailPanelRail } from "~/ui/detail-panel.tsx";

// Messages always render inside the app's panel: a delivered file opens there.
const render = (ui: Parameters<typeof renderUnwrapped>[0]) =>
  renderUnwrapped(ui, { wrapper: DetailPanelProvider });
import { composerText, setComposerText } from "./composer-test-utils.ts";
import { FileReferenceContext } from "./file-reference-context.ts";
import { FileCommentContext } from "~/modules/attachments/ui/file-comment.ts";

// Sources an earlier message registered, as the view hands them to a row.
const inheritedFrom = (sources: ToolSource[]) => inheritSources([sources, []])[1]!;

// The panel closes on navigation; the citation tests render outside a router.
vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: "/chat/test" }, matches: [] }),
}));

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
  beginSubmission: vi.fn(() => vi.fn()),
  markClaimed: vi.fn(),
  reset: vi.fn(),
  dismissNotice: vi.fn(),
});

/** Office steps sit inside the answer's work line, folded once it settles. */
const openWorkLines = () => {
  for (const header of screen.queryAllByRole("button", {
    expanded: false,
    name: /^(Created|Edited|Read|Published) (the|a) /,
  }))
    fireEvent.click(header);
};

describe("MessageBubble chronological body", () => {
  const intro = "First, a little context.\n\n";
  const ask: ToolActivity = {
    family: "ask",
    callId: "ask-order",
    name: "ask_user",
    status: "complete",
    textOffset: intro.length,
    turnIndex: 0,
    callIndex: 0,
    questions: [{ question: "Where next?", options: [], multiSelect: false }],
  };
  const base: DisplayMessage = {
    id: "ordered",
    role: "assistant",
    content: intro + "After the question.",
    reasoning: "",
    reasoningSeen: false,
    toolActivities: [ask],
    status: "complete",
    questionActions: { onRespond: vi.fn() },
  };

  it("renders introductions before the question and same-round trailing prose after it", () => {
    render(<MessageBubble message={base} />);
    const before = screen.getByText("First, a little context.");
    const question = screen.getByText("Where next?");
    const after = screen.getByText("After the question.");
    expect(
      before.compareDocumentPosition(question) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(question.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(1);
  });

  it("shows a created document's card, then its fill as one work line", () => {
    const call = (
      callId: string,
      name: "create_document" | "edit_document",
      callIndex: number,
      outcome: "created" | "updated" | "conflict",
    ): ToolActivity => ({
      family: "document",
      name,
      callId,
      status: "complete",
      textOffset: 0,
      turnIndex: callIndex,
      callIndex: 0,
      result: { outcome, documentId: "doc-1", title: "A very long thesis title" },
    });
    render(
      <MessageBubble
        message={{
          ...base,
          content: "Filled it.",
          toolActivities: [
            call("create", "create_document", 0, "created"),
            call("fill-1", "edit_document", 1, "updated"),
            call("fill-2", "edit_document", 2, "conflict"),
            call("fill-3", "edit_document", 3, "updated"),
          ],
        }}
      />,
    );
    // One line for the three edits, without repeating the title the card shows.
    const header = screen.getByRole("button", { name: "Edited the document" });
    const card = screen.getByText("A very long thesis title");
    expect(card.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/Couldn’t update/)).toBeNull();
    fireEvent.click(header);
    expect(screen.getAllByText("Edited the document")).toHaveLength(2);
  });

  const edit: ToolActivity = {
    family: "presentation",
    name: "edit_presentation",
    callId: "edit-one",
    status: "complete",
    textOffset: 0,
    turnIndex: 0,
    callIndex: 0,
    workingFileId: "draft-one",
    revision: 1,
    outcome: "working",
    message: "Private draft updated.",
    origin: "created",
    changes: "Added a slide and wrote the text",
    slideCount: 2,
  };
  const check: ToolActivity = {
    family: "presentation",
    name: "render_presentation",
    callId: "render-one",
    status: "complete",
    textOffset: 0,
    turnIndex: 1,
    callIndex: 0,
    workingFileId: "draft-one",
    revision: 1,
    outcome: "complete",
    message: "Approximate slide images follow.",
    renderedSlideIds: [256, 257],
  };

  it("keeps a run of reads live while the model thinks, and names what each read covered", () => {
    const read = (callIndex: number, extra: Partial<ToolActivity>): ToolActivity =>
      ({
        family: "presentation",
        name: "inspect_presentation",
        callId: `read-${callIndex}`,
        status: "complete",
        textOffset: 0,
        turnIndex: 0,
        callIndex,
        outcome: "complete",
        message: "Inspection covers the listed page only.",
        slideCount: 24,
        ...extra,
      }) as ToolActivity;
    const reads = [
      read(0, { read: { from: 1, to: 10 } }),
      read(1, { read: { from: 11, to: 20 } }),
      read(2, { read: { from: 1, to: 10, slides: [5] } }),
      read(3, { read: { from: 1, to: 10, slides: [5] } }),
      read(4, { read: { from: 1, to: 10, slides: [18, 6, 7] } }),
      read(5, { read: { from: 1, to: 10, slides: [3, 4] } }),
      read(6, { read: { from: 1, to: 10, template: "layout" } }),
      read(7, { read: { from: 1, to: 10, template: "master" } }),
    ];
    const { rerender } = render(
      <MessageBubble
        message={{ ...base, status: "streaming", content: "", toolActivities: reads }}
      />,
    );
    // Between calls the model is still working: live, not "Read presentation",
    // and without a second label repeating the first.
    const header = screen.getByRole("button", { name: "Reading presentation" });
    expect(screen.queryByText("Reading slides")).toBeNull();
    expect(screen.queryByText("Thinking")).toBeNull();
    fireEvent.click(header);
    expect(screen.getByText("Read slides 1–10")).toBeInTheDocument();
    expect(screen.getByText("Read slides 11–20")).toBeInTheDocument();
    expect(screen.getByText("Read slide 5 · 2 times")).toBeInTheDocument();
    expect(screen.getByText("Read slides 6, 7 and 18")).toBeInTheDocument();
    expect(screen.getByText("Read slides 3–4")).toBeInTheDocument();
    expect(screen.getByText("Read slide layout")).toBeInTheDocument();
    expect(screen.getByText("Read slide master")).toBeInTheDocument();
    expect(screen.queryByText(/Checked appearance/)).toBeNull();
    // Editing a deck it has read is editing, not creating one.
    rerender(
      <MessageBubble
        message={{
          ...base,
          status: "streaming",
          content: "",
          toolActivities: [
            ...reads,
            { ...edit, callId: "open", status: "running", callIndex: 7, workingFileId: undefined },
          ] as ToolActivity[],
        }}
      />,
    );
    expect(
      screen.getByRole("button", { name: /^Working on presentation\s?·\s?Editing slides/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Creating the deck")).toBeNull();
    // While the model is still writing the call, the row says so.
    rerender(
      <MessageBubble
        message={{
          ...base,
          status: "streaming",
          content: "",
          toolActivities: [
            ...reads,
            {
              family: "presentation",
              name: "edit_presentation",
              callId: "writing:call",
              status: "running",
              textOffset: 0,
              turnIndex: 1,
              callIndex: Number.MAX_SAFE_INTEGER,
              writing: true,
            },
          ],
        }}
      />,
    );
    expect(
      screen.getByRole("button", { name: /^Working on presentation\s?·\s?Writing changes/ }),
    ).toBeInTheDocument();
    rerender(<MessageBubble message={{ ...base, content: "", toolActivities: reads }} />);
    expect(screen.getByRole("button", { name: "Read presentation" })).toBeInTheDocument();
  });

  it("shows a published draft as one line with its file beneath and steps on demand", () => {
    render(
      <MessageBubble
        message={{
          ...base,
          content: "",
          toolActivities: [
            edit,
            check,
            {
              family: "tool-file",
              name: "publish_file",
              callId: "publish-one",
              status: "complete",
              textOffset: 0,
              turnIndex: 2,
              callIndex: 0,
              workingFileId: "draft-one",
              attachmentId: "deck-file",
            },
          ],
          files: [
            {
              v: 1,
              attachment: {
                id: "deck-file",
                fileName: "Q3.pptx",
                size: 10240,
                mediaType:
                  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                kind: "file",
              },
              textOffset: 0,
              turnIndex: 2,
              eventIndex: 1,
              callIndex: 0,
            },
          ],
        }}
      />,
    );
    openWorkLines();
    const header = screen.getByRole("button", { name: "Created presentation · 2 slides" });
    expect(screen.getAllByText("Q3.pptx")).toHaveLength(1);
    expect(screen.queryByText(/File ready/)).toBeNull();
    fireEvent.click(header);
    expect(screen.getByText("Started a new deck")).toBeInTheDocument();
    expect(screen.getByText("Built the slides")).toBeInTheDocument();
    expect(screen.queryByText(/added a slide and wrote/)).toBeNull();
    expect(screen.getByText("Checked appearance of 2 slides")).toBeInTheDocument();
    expect(screen.getByText("Published Q3.pptx")).toBeInTheDocument();
  });

  it("does not badge a recovered step failure on a delivered presentation, nor show its model text", () => {
    render(
      <MessageBubble
        message={{
          ...base,
          content: "",
          toolActivities: [
            edit,
            {
              ...edit,
              callId: "bad-edit",
              status: "error",
              outcome: "error",
              error: "invalid_operation: Provide exactly one of create, sourceRef or workingRef.",
            },
            {
              ...edit,
              callId: "fixed-edit",
              revision: 2,
            },
            {
              family: "tool-file",
              name: "publish_file",
              callId: "publish",
              status: "complete",
              textOffset: 0,
              turnIndex: 3,
              callIndex: 0,
              workingFileId: "draft-one",
              attachmentId: "deck-file",
            },
          ],
        }}
      />,
    );
    openWorkLines();
    const header = screen.getByRole("button", { name: "Created presentation · 2 slides" });
    expect(header).not.toHaveTextContent("step failed");
    fireEvent.click(header);
    expect(screen.getByText("Couldn’t apply an edit")).toBeInTheDocument();
    expect(screen.queryByText(/Provide exactly one of create/)).toBeNull();
  });

  it("names each kind of failed step in reader words", () => {
    const failure = (callId: string, name: string, callIndex: number): ToolActivity => ({
      family: "presentation",
      name,
      callId,
      status: "error",
      textOffset: 0,
      turnIndex: 1,
      callIndex,
      workingFileId: "draft-one",
      outcome: "error",
      message: "invalid_operation: operations[8] setText.placeholder: unknown",
      error: "invalid_operation: operations[8] setText.placeholder: unknown",
    });
    render(
      <MessageBubble
        message={{
          ...base,
          content: "",
          toolActivities: [
            edit,
            failure("bad-read", "inspect_presentation", 0),
            failure("bad-check", "render_presentation", 1),
            failure("bad-edit", "edit_presentation", 2),
            {
              family: "tool-file",
              name: "publish_file",
              callId: "bad-publish",
              status: "error",
              textOffset: 0,
              turnIndex: 2,
              callIndex: 0,
              workingFileId: "draft-one",
              error: "attachment_limit: 5 files per message",
            },
          ],
        }}
      />,
    );
    openWorkLines();
    fireEvent.click(screen.getByRole("button", { name: /^Presentation draft/ }));
    for (const label of [
      "Couldn’t read the presentation",
      "Couldn’t check the slides",
      "Couldn’t apply an edit",
      "Couldn’t publish the file",
    ])
      expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.queryByText(/invalid_operation|attachment_limit/)).toBeNull();
  });

  it("says a first edit creates the deck in the header and the steps alike", () => {
    const first: ToolActivity = {
      family: "presentation",
      name: "edit_presentation",
      callId: "first-edit",
      status: "running",
      textOffset: 0,
      turnIndex: 0,
      callIndex: 0,
    };
    render(
      <MessageBubble
        message={{
          ...base,
          status: "streaming",
          content: "",
          toolActivities: [first],
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Working on presentation/ }));
    expect(screen.getAllByText("Creating the deck")).toHaveLength(2);
    expect(screen.queryByText("Editing slides")).toBeNull();
  });

  it("speaks about a workbook in cells and sheets, and says when formulas show errors", () => {
    const workbook = (callIndex: number, extra: Partial<ToolActivity>): ToolActivity =>
      ({
        family: "spreadsheet",
        callId: `sheet-${callIndex}`,
        status: "complete",
        textOffset: 0,
        turnIndex: callIndex,
        callIndex: 0,
        outcome: "complete",
        message: "Read the returned cells as data.",
        ...extra,
      }) as ToolActivity;
    render(
      <MessageBubble
        message={{
          ...base,
          content: "",
          toolActivities: [
            workbook(0, {
              name: "edit_spreadsheet",
              workingFileId: "book",
              revision: 1,
              outcome: "working",
              origin: "created",
              changes: "Wrote a cell range",
              sheetCount: 2,
              formulaErrors: 1,
            }),
            workbook(1, {
              name: "inspect_spreadsheet",
              workingFileId: "book",
              read: { sheet: 2, range: "A1:D9" },
            }),
          ],
        }}
      />,
    );
    openWorkLines();
    fireEvent.click(screen.getByRole("button", { name: /Spreadsheet draft/ }));
    for (const label of [
      "Started a new workbook",
      "Wrote the cells",
      "1 formula shows an error",
      "Read A1:D9 on sheet 2",
    ])
      expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.queryByText(/slide/i)).toBeNull();
  });

  it("keeps an unfinished draft as the live line instead of Thinking, then labels the unpublished draft", () => {
    const failed: ToolActivity = {
      family: "presentation",
      name: "edit_presentation",
      callId: "edit-two",
      status: "error",
      textOffset: 0,
      turnIndex: 2,
      callIndex: 0,
      outcome: "error",
      message: "invalid_operation: operations[0] addText: missing x",
      error: "invalid_operation: operations[0] addText: missing x",
    };
    const { rerender } = render(
      <MessageBubble
        message={{ ...base, status: "streaming", content: "", toolActivities: [edit, check] }}
      />,
    );
    expect(screen.getByText("Working on presentation")).toBeInTheDocument();
    // Keep the live label short; the individual steps are in the disclosure.
    expect(screen.getByText("Checking appearance")).toBeInTheDocument();
    expect(screen.queryByText("Thinking")).toBeNull();
    rerender(
      <MessageBubble
        message={{
          ...base,
          status: "streaming",
          content: "",
          toolActivities: [edit, check, { ...failed, status: "running", callId: "edit-running" }],
        }}
      />,
    );
    // A running call has no file ID yet; it must not open a second row.
    expect(screen.getAllByRole("button", { name: /presentation|slides/i })).toHaveLength(1);
    expect(screen.getByText("Editing slides")).toBeInTheDocument();
    rerender(
      <MessageBubble message={{ ...base, content: "", toolActivities: [edit, check, failed] }} />,
    );
    // A failed step is marked in the step list, never announced on the line.
    expect(screen.queryByText(/step failed/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Presentation draft/ }));
    expect(screen.getByText("Couldn’t apply an edit")).toBeInTheDocument();
    expect(screen.getByLabelText("Failed")).toBeInTheDocument();
  });

  it("labels a draft split by narration by what each part did, and never calls it unsaved once published", () => {
    const content = "Looks good. Publishing now.";
    const later = (
      activity: ToolActivity,
      textOffset: number,
      turnIndex: number,
    ): ToolActivity => ({
      ...activity,
      callId: `${activity.callId}-${turnIndex}`,
      textOffset,
      turnIndex,
    });
    const tools: ToolActivity[] = [
      edit,
      check,
      later(
        {
          family: "presentation",
          name: "edit_presentation",
          callId: "edit-revision",
          status: "complete",
          workingFileId: "draft-one",
          revision: 2,
          outcome: "working",
          message: "Private draft updated.",
          changes: "Added text",
          slideCount: 2,
          renderedSlideIds: [257],
        },
        27,
        2,
      ),
      later(check, 27, 3),
    ];
    const { rerender } = render(
      <MessageBubble message={{ ...base, status: "streaming", content, toolActivities: tools }} />,
    );
    // Only the newest part is live; the earlier one says what it did.
    openWorkLines();
    expect(
      screen.getByRole("button", { name: "Created presentation · 2 slides" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Working on presentation")).toBeInTheDocument();
    rerender(
      <MessageBubble
        message={{
          ...base,
          content,
          toolActivities: [
            ...tools,
            {
              family: "tool-file",
              name: "publish_file",
              callId: "publish-late",
              status: "complete",
              textOffset: 27,
              turnIndex: 4,
              callIndex: 0,
              workingFileId: "draft-one",
              attachmentId: "deck-late",
            },
          ],
        }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Created presentation · 2 slides" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edited presentation · 2 slides" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/draft/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edited presentation · 2 slides" }));
    expect(screen.getByText("Edited the slides")).toBeInTheDocument();
    expect(screen.getByText("Checked slide appearance")).toBeInTheDocument();
  });

  it("does not reveal an activity until displayed text reaches its fixed anchor", () => {
    const { rerender } = render(
      <MessageBubble
        message={{
          ...base,
          status: "streaming",
          content: "First,",
          rawTextLength: base.content.length,
        }}
      />,
    );
    expect(screen.queryByText("Where next?")).not.toBeInTheDocument();
    rerender(
      <MessageBubble
        message={{
          ...base,
          status: "streaming",
          content: intro,
          rawTextLength: base.content.length,
        }}
      />,
    );
    expect(screen.getByText("Where next?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip and continue" })).toBeDisabled();
  });

  it("keeps the same card and draft when the first source arrives", () => {
    const { rerender } = render(
      <DetailPanelProvider>
        <MessageBubble message={base} />
      </DetailPanelProvider>,
    );
    const draft = screen.getByRole("textbox", { name: "Your answer" });
    fireEvent.change(draft, { target: { value: "Keep this draft" } });
    rerender(
      <DetailPanelProvider>
        <MessageBubble
          message={{
            ...base,
            toolActivities: [
              ask,
              {
                family: "web",
                name: "web_search",
                callId: "late-source",
                turnIndex: 0,
                callIndex: 1,
                textOffset: base.content.length,
                status: "complete",
                targets: ["topic"],
                sources: [
                  {
                    kind: "web" as const,
                    index: 1,
                    url: "https://example.com",
                    title: "One source",
                    snippet: "",
                    read: true,
                  },
                ],
              },
            ],
          }}
        />
      </DetailPanelProvider>,
    );
    expect(screen.getByRole("textbox", { name: "Your answer" })).toBe(draft);
    expect(draft).toHaveValue("Keep this draft");
    expect(screen.getAllByRole("button", { name: "Message actions" })).toHaveLength(1);
  });

  it("renders partial markdown safely at tool boundaries and shares citations/actions across prose segments", () => {
    const first = "- First finding[^1]\n\n```text\nunfinished fence\n";
    const last = "Second finding[^1].";
    const source = {
      kind: "web" as const,
      index: 1,
      url: "https://example.com",
      title: "One source",
      snippet: "",
      read: false,
    };
    const { container } = render(
      <DetailPanelProvider>
        <MessageBubble
          message={{
            ...base,
            content: first + last,
            toolActivities: [
              {
                family: "web",
                callId: "source",
                name: "web_search",
                status: "complete",
                turnIndex: 0,
                callIndex: 0,
                textOffset: first.length,
                targets: ["topic"],
                sources: [source],
              },
            ],
          }}
        />
      </DetailPanelProvider>,
    );
    expect(container.querySelectorAll("pre")).toHaveLength(1);
    expect(screen.getByText("unfinished fence")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Source: One source" })).toHaveLength(2);
    expect(container.querySelector("[data-footnotes]")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Message actions" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(1);
  });
});

describe("MessageBubble ask activity", () => {
  it("keeps questions at their actual position between memory activity", () => {
    render(
      <MessageBubble
        message={{
          id: "assistant",
          role: "assistant",
          status: "complete",
          content: "",
          reasoning: "",
          reasoningSeen: false,
          toolActivities: [
            {
              family: "memory",
              callId: "after",
              name: "save_memory",
              turnIndex: 1,
              callIndex: 2,
              status: "complete",
              outcome: "unchanged",
            },
            {
              family: "ask",
              callId: "ask",
              name: "ask_user",
              turnIndex: 1,
              callIndex: 1,
              status: "complete",
              questions: [{ question: "Which direction?", multiSelect: false, options: [] }],
            },
            {
              family: "memory",
              callId: "before",
              name: "save_memory",
              turnIndex: 1,
              callIndex: 0,
              status: "complete",
              outcome: "created",
            },
          ],
          questionActions: { onRespond: vi.fn() },
        }}
      />,
    );
    const before = screen.getByText("Saved to memory");
    const question = screen.getByText("Which direction?");
    const after = screen.getByText("Memory already saved");
    expect(
      before.compareDocumentPosition(question) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(question.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip and continue" })).toBeEnabled();
  });
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
    expect(screen.getByText("Hello!")).toHaveClass("whitespace-pre-wrap", "wrap-anywhere");
  });

  it("wraps unbroken text steered into an assistant answer", () => {
    const content = "S".repeat(500);
    render(
      <MessageBubble
        message={{
          id: "steered",
          role: "assistant",
          content: "Answer",
          reasoning: "",
          reasoningSeen: false,
          toolActivities: [],
          status: "complete",
          steers: [{ id: "s1", content, textOffset: 6, turnIndex: 0, attachments: [] }],
        }}
      />,
    );
    expect(screen.getByText(content)).toHaveClass("whitespace-pre-wrap", "wrap-anywhere");
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
    expect(screen.getByText("Thinking")).toBeInTheDocument();
  });

  it("says scanned pages are being read, with the count apart from the steady label", () => {
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
          reading: { read: 4, total: 12 },
        }}
      />,
    );
    expect(screen.getByText("Reading scanned pages")).toBeInTheDocument();
    expect(screen.getByText("4 of 12")).toBeInTheDocument();
    expect(screen.queryByText("Thinking")).toBeNull();
  });

  it("shows a friendly alert for failed generations", () => {
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

    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("aria-atomic", "true");
    expect(within(alert).getByText("Couldn’t generate a response")).toBeInTheDocument();
    expect(within(alert).queryByText("Technical details")).toBeNull();
    expect(within(alert).queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("summarizes rate limits while preserving technical details and retry", () => {
    const onRetry = vi.fn();
    const error =
      "Cause([Fail(ProviderUnreachable: OpenRouterClient.createChatCompletionStream: Rate limit exceeded. Retry after 2s)])";
    const { container } = render(
      <MessageBubble
        message={{
          id: "3",
          role: "assistant",
          content: "partial",
          reasoning: "",
          reasoningSeen: false,
          toolActivities: [],
          status: "error",
          error,
          onRetry,
        }}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("This model is busy")).toBeInTheDocument();
    expect(within(alert).getByText(/Try again in 2 seconds/)).toBeInTheDocument();

    const detailsTrigger = within(alert).getByRole("button", { name: "Technical details" });
    expect(detailsTrigger).toHaveClass("gap-1", "text-xs", "rounded-lg", "focus-visible:ring-3");
    expect(detailsTrigger).not.toHaveClass("gap-1.5", "text-sm");
    expect(detailsTrigger.querySelector("svg")).toHaveClass("size-3", "transition-transform");
    expect(detailsTrigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(detailsTrigger);
    expect(detailsTrigger).toHaveAttribute("aria-expanded", "true");
    expect(within(alert).queryByText(error)).toBeNull();
    expect(within(alert).getByText("Rate limit exceeded. Retry after 2s")).toHaveClass(
      "[overflow-wrap:anywhere]",
    );
    expect(container.querySelector('[data-slot="collapsible-content"]')).toHaveClass(
      "transition-[height,opacity]",
      "data-ending-style:h-0",
    );

    within(alert).getByRole("button", { name: "Try again" }).click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("disables retry while another action is pending", () => {
    render(
      <MessageBubble
        message={{
          id: "3",
          role: "assistant",
          content: "",
          reasoning: "",
          reasoningSeen: false,
          toolActivities: [],
          status: "error",
          onRetry: vi.fn(),
          retryDisabled: true,
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();
  });
});

describe("MessageBubble attachments", () => {
  /**
   * A grid cell by what it shows, once it does. Querying by role and name would work out an
   * accessible name for every drawn cell, which takes seconds in jsdom.
   */
  const cellShowing = (text: string) =>
    waitFor(() => {
      const cell = [...document.querySelectorAll('[role="gridcell"]')].find(
        (node) => node.textContent === text,
      );
      expect(cell).toBeDefined();
      return cell!;
    });
  afterEach(() => vi.unstubAllGlobals());
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

  it("offers saving a sent file to the project, only in a project chat the reader edits", () => {
    const file = attachment({ id: "a-deck", fileName: "brief.txt" });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WritableChatProjectProvider project={{ id: "p1", name: "Relaunch" }}>
          <MessageBubble message={userMessage("", [file])} />
        </WritableChatProjectProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("link", { name: /brief\.txt/ }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Save to project" })).toBeInTheDocument();
    // The actions replace the preview's own link, so they carry it.
    expect(within(dialog).getByRole("link", { name: "Open original" })).toHaveAttribute(
      "href",
      "/api/files/a-deck",
    );
  });

  it("hands a comment on a sent workbook's cells to the chat, naming the file", async () => {
    const book = attachment({
      id: "0199a000-0000-7000-8000-000000000001",
      fileName: "book.xlsx",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      kind: "file",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          sheets: [{ name: "Data" }],
          sheet: "Data",
          rows: 1,
          cols: 1,
          cells: [{ row: 1, col: 1, value: "Price" }],
          styles: [],
          widths: [],
          heights: [],
          merges: [],
          hiddenRows: [],
          hiddenCols: [],
          conditional: [],
          charts: [],
          otherCharts: 0,
          images: [],
          truncated: false,
        }),
      ),
    );
    const send = vi.fn(async () => true);
    const view = render(
      <FileCommentContext value={send}>
        <MessageBubble message={userMessage("", [book])} />
      </FileCommentContext>,
    );
    fireEvent.click(screen.getByRole("link", { name: /book\.xlsx/ }));
    const dialog = screen.getByRole("dialog");
    await cellShowing("Price");
    fireEvent.click(within(dialog).getByRole("button", { name: "Comment" }));
    const box = await screen.findByRole("textbox", { name: "Comment on A1" });
    fireEvent.change(box, { target: { value: "Make it a total" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(send).toHaveBeenCalledExactlyOnceWith(
        `Comment on “Data!A1 · Price” in book.xlsx (attachment:${book.id}): Make it a total`,
      ),
    );
    // Outside a chat, as in a project's files, there is nobody to comment to.
    view.unmount();
    render(<MessageBubble message={userMessage("", [book])} />);
    fireEvent.click(screen.getByRole("link", { name: /book\.xlsx/ }));
    await cellShowing("Price");
    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
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
    family: "web",
    callId: "call-1",
    name: "web_search",
    targets: ["effect 4"],
    status: "complete",
    sources: [
      {
        kind: "web" as const,
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

  it("renders a footnote marker as a link to the source naming its site, not a number", () => {
    const { container } = renderCited("Effect 4.0 is out[^1].");

    // The title is the accessible name and waits in the hover card; the chip shows the site.
    const chip = screen.getByRole("link", { name: "Source: Effect 4.0 released" });
    expect(chip).toHaveAttribute("href", "https://effect.website/blog");
    expect(chip).toHaveAttribute("target", "_blank");
    expect(chip).toHaveTextContent("effect.website");
    expect(chip).not.toHaveTextContent("1");
    expect(container.textContent).not.toContain("[^1]");
  });

  it("keeps the same chip while the answer streams on, so its preview stays open", () => {
    const bubble = (content: string) => (
      <DetailPanelProvider>
        <MessageBubble
          message={{
            id: "cited",
            role: "assistant",
            content,
            reasoning: "",
            reasoningSeen: false,
            toolActivities: [searchActivity],
            status: "streaming",
          }}
        />
      </DetailPanelProvider>
    );
    const { rerender } = render(bubble("Effect 4.0 is out[^1]. It"));
    const chip = screen.getByRole("link", { name: "Source: Effect 4.0 released" });
    // Each token recomputes the sources; a remount here would close a hovered preview.
    rerender(bubble("Effect 4.0 is out[^1]. It ships"));
    rerender(bubble("Effect 4.0 is out[^1]. It ships with a new runtime"));
    expect(screen.getByRole("link", { name: "Source: Effect 4.0 released" })).toBe(chip);
  });

  it("composes citations, live file references and normal-link confirmation without remounting", () => {
    const file = {
      id: "live-file",
      fileName: "generated.png",
      kind: "image" as const,
      mediaType: "image/png",
      size: 4,
    };
    const client = new QueryClient();
    const bubble = (available: boolean) => (
      <QueryClientProvider client={client}>
        <FileReferenceContext
          value={{
            attachments: new Map(available ? [[file.id, file]] : []),
            aliases: null,
            machineId: null,
          }}
        >
          <DetailPanelProvider>
            <MessageBubble
              message={{
                id: "mixed",
                role: "assistant",
                content: "Result[^1] [file](/api/files/live-file) [Website](https://example.com)",
                reasoning: "",
                reasoningSeen: false,
                toolActivities: [searchActivity],
                status: "streaming",
              }}
            />
          </DetailPanelProvider>
        </FileReferenceContext>
      </QueryClientProvider>
    );
    const { rerender } = render(bubble(false));
    const citation = screen.getByRole("link", { name: "Source: Effect 4.0 released" });
    expect(screen.queryByRole("button", { name: "Preview generated.png" })).not.toBeInTheDocument();
    rerender(bubble(true));
    expect(screen.getByRole("link", { name: "Source: Effect 4.0 released" })).toBe(citation);
    fireEvent.click(screen.getByRole("button", { name: "Preview generated.png" }));
    expect(within(screen.getByRole("dialog")).getByRole("img")).toHaveAttribute(
      "src",
      "/api/files/live-file",
    );
    rerender(bubble(false));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Preview generated.png" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Website" }));
    expect(screen.getByText("Open external link?")).toBeInTheDocument();
  });

  it("shows adjacent markers as one chip naming the first source and the rest", () => {
    const activity: ToolActivity = {
      ...searchActivity,
      sources: [
        ...searchActivity.sources!,
        {
          kind: "web" as const,
          index: 2,
          url: "https://github.com/Effect-TS/effect",
          title: "Effect on GitHub",
          snippet: "",
          read: true,
        },
      ],
    };
    const { container } = render(
      <DetailPanelProvider>
        <MessageBubble
          message={{
            id: "grouped",
            role: "assistant",
            content: "Effect 4.0 is out[^1][^2].",
            reasoning: "",
            reasoningSeen: false,
            toolActivities: [activity],
            status: "complete",
          }}
        />
      </DetailPanelProvider>,
    );

    const chip = screen.getByRole("link", { name: "Sources: Effect 4.0 released and 1 more" });
    expect(chip).toHaveAttribute("href", "https://effect.website/blog");
    expect(chip).toHaveTextContent("+1");
    expect(screen.getAllByRole("link", { name: /^Sources?:/ })).toHaveLength(1);
    expect(container.textContent).not.toContain("[^");
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
  const renderPlain = (
    overrides: Partial<Parameters<typeof MessageBubble>[0]["message"]> = {},
    seed?: (client: QueryClient) => void,
  ) => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["capabilities"], ALL_CAPABILITIES);
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
    seed?.(queryClient);
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

  it("shows a user turn's collection by name beside its files, and no row on the answer", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      ["knowledge", "collections"],
      [
        {
          id: "c-contracts",
          name: "Contracts",
          description: "",
          audience: "private",
          canEdit: true,
          ownerName: null,
          documentCount: 1,
          readyCount: 1,
          failedCount: 0,
          pendingCount: 0,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    );
    queryClient.setQueryData(["chat-models"], []);
    render(
      <QueryClientProvider client={queryClient}>
        <MessageBubble
          message={{
            id: "question",
            role: "user",
            content: "Summarize these.",
            reasoning: "",
            reasoningSeen: false,
            toolActivities: [],
            status: "complete",
            collectionIds: ["c-contracts"],
          }}
        />
        <MessageBubble
          message={{
            id: "answer",
            role: "assistant",
            content: "Summary.",
            reasoning: "",
            reasoningSeen: false,
            status: "complete",
            toolActivities: [
              {
                family: "knowledge",
                name: "knowledge_context",
                callId: "ctx",
                status: "complete",
                turnIndex: 0,
                callIndex: 0,
                textOffset: 0,
                summary: {
                  targets: [],
                  documentsListed: 1,
                  passagesReturned: 1,
                  remainingOps: 64,
                  coverage: "",
                },
                sources: [],
              },
            ],
          }}
        />
      </QueryClientProvider>,
    );
    // The chip carries the collection's name and no document-level detail.
    const chip = screen.getByText("Contracts");
    expect(chip.closest(".group\\/user")).not.toBeNull();
    expect(screen.getByText("Collection")).toBeInTheDocument();
    expect(screen.queryByText(/Included in full|Selected documents|Reading selected/)).toBeNull();
  });

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
            inheritedSources: inheritedFrom([
              {
                kind: "web" as const,
                index: 2,
                url: "https://effect.website",
                title: "Effect docs",
                snippet: "",
                read: true,
              },
              // Uncited inherited sources stay out of the chip set entirely.
              {
                kind: "web" as const,
                index: 3,
                url: "https://other.dev",
                title: "Other",
                snippet: "",
                read: false,
              },
            ]),
          }}
        />
      </DetailPanelProvider>,
    );
    expect(screen.getByRole("link", { name: "Source: Effect docs" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Source: Other" })).toBeNull();
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

  it("shows what a request is about as a chip and reads the rest as plain words", () => {
    renderPlain(
      {
        role: "user",
        content: "Help me improve [this agent](/agents/a1). Ask what I’d like to change.",
      },
      (client) =>
        client.setQueryData(
          ["agents", "list"],
          [{ id: "a1", name: "Contract reviewer", icon: "robot" }],
        ),
    );
    expect(screen.getByText("Contract reviewer")).toBeVisible();
    expect(
      screen.getByText("Help me improve this agent. Ask what I’d like to change."),
    ).toBeVisible();
    expect(screen.queryByText(/\/agents\/a1/)).not.toBeInTheDocument();
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

  it("keeps branching off user messages, since only an answer can be forked", () => {
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

  it("offers resume beside try again on a failed answer and resumes with the same model", async () => {
    const onResume = vi.fn();
    const onResumeWith = vi.fn();
    const onRetry = vi.fn();
    renderPlain({
      status: "error",
      content: "Half a deck",
      onRetry,
      onResume,
      onResumeWith,
      retryModelId: "model-1",
    });

    const alert = screen.getByRole("alert");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    within(alert).getByRole("combobox", { name: "Resume" }).click();
    (await screen.findByRole("button", { name: /Resume same/ })).click();

    expect(onResume).toHaveBeenCalledOnce();
    expect(onResumeWith).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("resumes a stopped answer with no text, on another model", async () => {
    const onResume = vi.fn();
    const onResumeWith = vi.fn();
    renderPlain({
      status: "aborted",
      content: "",
      onResume,
      onResumeWith,
      retryModelId: "model-1",
    });

    expect(screen.getByText("Stopped.")).toBeInTheDocument();
    screen.getByRole("combobox", { name: "Resume" }).click();
    (await screen.findByRole("option", { name: /Other Model/ })).click();

    expect(onResumeWith).toHaveBeenCalledWith("model-2");
    expect(onResume).not.toHaveBeenCalled();
  });

  it("offers no resume where the chat view wired none, and disables it while busy", () => {
    const { unmount } = renderPlain({ status: "aborted", content: "" });
    expect(screen.queryByRole("combobox", { name: "Resume" })).toBeNull();
    unmount();
    renderPlain({
      status: "aborted",
      content: "",
      onResume: vi.fn(),
      onResumeWith: vi.fn(),
      retryDisabled: true,
    });
    expect(screen.getByRole("combobox", { name: "Resume" })).toBeDisabled();
  });

  it("offers edit only when a user message wires it", () => {
    const onEdit = vi.fn();
    renderPlain({ role: "user", onEdit });
    screen.getByRole("button", { name: "Edit" }).click();
    expect(onEdit).toHaveBeenCalledOnce();
  });

  it("keeps the inline edit draft local and wires its actions", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    renderPlain({
      role: "user",
      editState: {
        initialDraft: "updated message",
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

    const editor = screen.getByRole("textbox", { name: "Edit message" });
    expect(composerText(editor)).toBe("updated message");
    setComposerText(editor, "new draft");
    expect(composerText(editor)).toBe("new draft");
    expect(screen.getByRole("button", { name: "Add attachment" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search the web" })).toBeInTheDocument();
    expect(screen.getByText("Test Model")).toBeInTheDocument();
    screen.getByRole("button", { name: "Save edit" }).click();
    screen.getByRole("button", { name: "Cancel" }).click();
    expect(onSave).toHaveBeenCalledWith("new draft");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("disables Save for an empty edit draft", () => {
    renderPlain({
      role: "user",
      editState: {
        initialDraft: "   ",
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

  it("names the connected app that sent a message", () => {
    renderPlain({ role: "user", originClientName: "Claude" });
    expect(screen.getByText("via Claude")).toBeInTheDocument();
    renderPlain({ role: "user", originClientName: "Cursor", editedAt: new Date() });
    expect(screen.getByText("via Cursor · edited")).toBeInTheDocument();
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

    const trigger = screen.getByRole("button", { name: "Earlier messages shortened" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/append-only/)).toBeNull();

    fireEvent.click(trigger);
    expect(await screen.findByText(/append-only/)).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("draws no compaction activity when none occurred", () => {
    renderPlain();
    expect(screen.queryByRole("button", { name: "Earlier messages shortened" })).toBeNull();
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

    expect(screen.getByText("Shortening earlier messages")).toBeInTheDocument();
    expect(screen.queryByText("Thinking")).toBeNull();
    // Nothing to expand yet. A dead button would just be noise.
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

    const trigger = screen.getByRole("button", { name: "Earlier messages shortened" });
    expect(screen.queryByText(/append-only/)).toBeNull();

    fireEvent.click(trigger);
    expect(await screen.findByText(/append-only/)).toBeInTheDocument();
  });

  it("renders each memory call as a compact row and suppresses Thinking while one runs", () => {
    renderPlain({
      status: "streaming",
      content: "",
      toolActivities: [
        {
          family: "memory",
          callId: "memory-1",
          name: "save_memory",
          turnIndex: 0,
          callIndex: 0,
          status: "complete",
          outcome: "created",
        },
        {
          family: "memory",
          callId: "memory-2",
          name: "save_memory",
          turnIndex: 0,
          callIndex: 1,
          status: "running",
        },
      ],
    });

    expect(screen.getByText("Saved to memory")).toBeInTheDocument();
    expect(screen.getByText("Saving to memory")).toBeInTheDocument();
    expect(screen.queryByText("Thinking")).toBeNull();
    expect(screen.queryByRole("button", { name: /memory/i })).toBeNull();
  });

  it("groups a completed search with a later-turn page read", () => {
    renderPlain({
      status: "streaming",
      content: "",
      toolActivities: [
        {
          family: "web",
          callId: "search-1",
          name: "web_search",
          turnIndex: 0,
          callIndex: 0,
          targets: ["effect"],
          status: "complete",
          resultCount: 1,
          sources: [
            {
              kind: "web" as const,
              index: 1,
              url: "https://effect.website/search-result",
              title: "Search-only result",
              snippet: "Search snippet",
              read: false,
            },
          ],
        },
        {
          family: "web",
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

    // Inside the open work line the search step stays folded until asked.
    const research = screen.getByRole("button", { name: "Reading effect.website" });
    expect(research).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(research);
    expect(screen.queryByText("Search-only result")).not.toBeInTheDocument();
    expect(screen.getByText("Reading this page")).toBeInTheDocument();
  });

  it("keeps parallel calls from the same model turn in one block", () => {
    renderPlain({
      status: "streaming",
      content: "",
      toolActivities: [
        {
          family: "web",
          callId: "search-1",
          name: "web_search",
          turnIndex: 0,
          callIndex: 0,
          targets: ["effect"],
          status: "complete",
        },
        {
          family: "web",
          callId: "read-1",
          name: "read_url",
          turnIndex: 0,
          callIndex: 1,
          targets: ["https://effect.website"],
          status: "running",
        },
      ],
    });

    expect(screen.getAllByRole("button", { name: "Reading effect.website" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Searched the web/ })).toBeNull();
  });

  it("keeps memory activity between separate research groups", () => {
    renderPlain({
      toolActivities: [
        {
          family: "web",
          callId: "search-1",
          name: "web_search",
          turnIndex: 0,
          callIndex: 0,
          targets: ["effect"],
          status: "complete",
        },
        {
          family: "memory",
          callId: "memory-1",
          name: "save_memory",
          turnIndex: 1,
          callIndex: 0,
          status: "complete",
          outcome: "created",
        },
        {
          family: "web",
          callId: "read-1",
          name: "read_url",
          turnIndex: 1,
          callIndex: 1,
          targets: ["https://effect.website"],
          status: "complete",
        },
      ],
    });

    // Two runs of work, each its own line, with the memory save between them.
    const search = screen.getByRole("button", { name: "Searched the web" });
    const memory = screen.getByText("Saved to memory");
    const read = screen.getByRole("button", { name: "Read a page" });
    expect(search.compareDocumentPosition(memory) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(memory.compareDocumentPosition(read) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("opens the final source list from completed research activity", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    render(
      <DetailPanelProvider>
        <MessageBubble
          message={{
            id: "research-complete",
            role: "assistant",
            content: "A researched answer.[^1]",
            reasoning: "",
            reasoningSeen: false,
            status: "complete",
            toolActivities: [
              {
                family: "web",
                callId: "search-1",
                name: "web_search",
                targets: ["effect"],
                status: "complete",
                sources: [
                  {
                    kind: "web" as const,
                    index: 1,
                    url: "https://effect.website/docs",
                    title: "Effect source",
                    snippet: "Documentation excerpt",
                    read: false,
                  },
                ],
              },
            ],
          }}
        />
        <DetailPanelRail />
      </DetailPanelProvider>,
    );

    // The search sits inside the answer's work line; open it, then the search.
    fireEvent.click(screen.getByRole("button", { name: "Searched the web" }));
    fireEvent.click(screen.getByRole("button", { name: "Searched the web · 1 source" }));
    fireEvent.click(screen.getByRole("button", { name: "View all sources" }));

    const panel = screen.getByRole("complementary", { name: "Sources" });
    expect(within(panel).getByText("Effect source")).toBeInTheDocument();
    expect(within(panel).getByText("Documentation excerpt")).toBeInTheDocument();
  });

  it("lists only the sources the answer cited or read, not every search hit", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    Element.prototype.scrollIntoView = vi.fn();
    const hit = (index: number, read = false) => ({
      kind: "web" as const,
      index,
      url: `https://example.org/${index}`,
      title: `Source ${index}`,
      snippet: "",
      read,
    });
    render(
      <DetailPanelProvider>
        <MessageBubble
          message={{
            id: "many-hits",
            role: "assistant",
            content: "Supported[^2] and confirmed[^7].",
            reasoning: "",
            reasoningSeen: false,
            status: "complete",
            toolActivities: [
              {
                family: "web",
                callId: "search-1",
                name: "web_search",
                targets: ["effect"],
                status: "complete",
                sources: [hit(1), hit(2), hit(3), hit(4)],
              },
              {
                family: "web",
                callId: "read-1",
                name: "read_url",
                targets: ["https://example.org/5"],
                status: "complete",
                sources: [hit(5, true)],
              },
            ],
            inheritedSources: inheritedFrom([hit(6), hit(7)]),
          }}
        />
        <DetailPanelRail />
      </DetailPanelProvider>,
    );
    // Cited own, read own and cited inherited, not the two uncited hits. The
    // tool row counts the same way: two of its five hits made the list.
    // The search sits inside the answer's work line; open it, then the search.
    fireEvent.click(screen.getByRole("button", { name: "Searched the web and read a page" }));
    fireEvent.click(screen.getByRole("button", { name: "Searched the web · 2 sources" }));
    fireEvent.click(screen.getByRole("button", { name: "View all sources" }));
    const panel = screen.getByRole("complementary", { name: "Sources" });
    expect(
      within(panel)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining("Source 2"),
      expect.stringContaining("Source 5"),
      expect.stringContaining("Source 7"),
    ]);
    expect(within(panel).queryByText("Source 1")).toBeNull();
    // Rows carry no citation number; the title identifies the source.
    expect(within(panel).queryByText(/^[257]$/)).toBeNull();
  });

  it("orders tool, compaction, then later tool by model turn", () => {
    renderPlain({
      toolActivities: [
        {
          family: "web",
          callId: "search-1",
          name: "web_search",
          turnIndex: 0,
          callIndex: 0,
          targets: ["effect"],
          status: "complete",
        },
        {
          family: "web",
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

    // One run of work: its header sums it up, and its steps keep model-turn order.
    fireEvent.click(
      screen.getByRole("button", {
        name: "Searched the web, summarized earlier messages and read a page",
      }),
    );
    const search = screen.getByRole("button", { name: "Searched the web" });
    const compact = screen.getByRole("button", { name: "Earlier messages shortened" });
    const read = screen.getByRole("button", { name: /Read a page/ });
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
    expect(screen.getByText("Earlier messages left out")).toBeInTheDocument();
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

    expect(screen.getByText("Couldn’t shorten earlier messages")).toBeInTheDocument();
  });
});

describe("generated image replies", () => {
  const image = {
    v: 1 as const,
    attachment: {
      id: "generated-private",
      fileName: "generated.png",
      size: 68,
      mediaType: "image/png",
      kind: "image" as const,
    },
    textOffset: 0,
    turnIndex: 0,
    eventIndex: 1,
    callIndex: 0,
  };
  const message: DisplayMessage = {
    id: "image-answer",
    role: "assistant",
    content: "",
    reasoning: "",
    reasoningSeen: false,
    toolActivities: [],
    status: "complete",
    files: [image],
  };
  it("opens a document delivered while the answer streams beside the chat, once, and never on reload", () => {
    const delivered = (id: string, status: string) => (
      <DetailPanelProvider>
        <MessageBubble
          message={{
            ...message,
            id: `answer-${id}`,
            content: "Here is the report.",
            status,
            files: [
              {
                ...image,
                attachment: {
                  id,
                  fileName: `${id}.pdf`,
                  size: 2048,
                  mediaType: "application/pdf",
                  kind: "pdf",
                },
                textOffset: 19,
                origin: { toolCallId: "call-1" },
              },
            ],
          }}
        />
        <DetailPanelRail />
      </DetailPanelProvider>
    );
    const live = renderUnwrapped(delivered("live-report", "streaming"));
    expect(screen.getByRole("complementary", { name: "live-report.pdf" })).toBeInTheDocument();
    live.unmount();
    renderUnwrapped(delivered("old-report", "complete"));
    expect(screen.queryByRole("complementary", { name: "old-report.pdf" })).toBeNull();
  });

  it("renders a tool's document as a chip at its place in the text", () => {
    render(
      <MessageBubble
        message={{
          ...message,
          content: "Here is the report.",
          files: [
            {
              ...image,
              attachment: {
                id: "tool-pdf",
                fileName: "q3.pdf",
                size: 2048,
                mediaType: "application/pdf",
                kind: "pdf",
              },
              textOffset: 19,
              origin: { toolCallId: "call-1" },
            },
          ],
        }}
      />,
    );
    const chip = screen.getByRole("link", { name: /q3\.pdf/ });
    expect(chip).toHaveAttribute("href", "/api/files/tool-pdf");
    expect(screen.queryByRole("img")).toBeNull();
  });
  it("renders a reloaded image-only reply with authenticated open/download actions and no empty copy", () => {
    render(<MessageBubble message={message} />);
    const img = screen.getByRole("img", { name: "Generated image" });
    expect(img).toHaveAttribute("src", "/api/files/generated-private");
    expect(screen.getByRole("link", { name: "Preview generated.png" })).toHaveAttribute(
      "href",
      "/api/files/generated-private",
    );
    expect(screen.queryByRole("link", { name: "Download image" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
    expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
    expect(screen.getByText("Loading image…")).toBeInTheDocument();
    fireEvent.load(img);
    expect(screen.queryByText("Loading image…")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Preview generated.png" }));
    const dialog = screen.getByRole("dialog", { name: "generated.png" });
    expect(within(dialog).getByRole("img", { name: "generated.png" })).toHaveAttribute(
      "src",
      "/api/files/generated-private",
    );
    expect(within(dialog).getByRole("link", { name: "Open original" })).toHaveAttribute(
      "href",
      "/api/files/generated-private",
    );
  });
  it("replaces the image URL and preview target when an answer receives a different attachment", () => {
    const { rerender } = render(<MessageBubble message={message} />);
    fireEvent.load(screen.getByRole("img", { name: "Generated image" }));
    const edited = { ...image, attachment: { ...image.attachment, id: "edited-private" } };
    rerender(<MessageBubble message={{ ...message, files: [edited] }} />);
    expect(screen.getByRole("img", { name: "Generated image" })).toHaveAttribute(
      "src",
      "/api/files/edited-private",
    );
    expect(screen.getByText("Loading image…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Preview generated.png" }));
    const dialog = screen.getByRole("dialog", { name: "generated.png" });
    expect(within(dialog).getByRole("img", { name: "generated.png" })).toHaveAttribute(
      "src",
      "/api/files/edited-private",
    );
    expect(within(dialog).getByRole("link", { name: "Open original" })).toHaveAttribute(
      "href",
      "/api/files/edited-private",
    );
  });
  it("reports an unavailable authenticated image without exposing storage details", () => {
    render(<MessageBubble message={message} />);
    fireEvent.error(screen.getByRole("img", { name: "Generated image" }));
    expect(screen.getByRole("alert")).toHaveTextContent("This image could not be loaded.");
  });
});

for (const [code, copy] of Object.entries(RESPONSE_FAILURES)) {
  it(`shows ${code} explanation and retry without technical disclosure`, async () => {
    const onRetry = vi.fn();
    render(
      <MessageBubble
        message={{
          id: "terminal-failure",
          role: "assistant",
          content: "",
          reasoning: "",
          reasoningSeen: false,
          toolActivities: [],
          status: "error",
          error: `Cause([Fail(Error: [${code}])])`,
          onRetry,
        }}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(copy.title)).toBeInTheDocument();
    expect(within(alert).getByText(copy.description)).toBeInTheDocument();
    expect(within(alert).queryByText("Technical details")).toBeNull();
    expect(screen.queryByText("Thinking")).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
}

const snapshot = (text: string): LiveTextSnapshot => ({
  text,
  reasoning: "weighing it",
  rawTextLength: text.length + 5,
  reasoningSeen: true,
  drained: false,
});

describe("answer tables", () => {
  it("take their full height instead of scrolling inside the transcript", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => `| row ${i} | value ${i} |`).join("\n");
    const { container } = render(
      <MessageBubble
        message={{
          id: "table",
          role: "assistant",
          content: `| name | value |\n| --- | --- |\n${rows}`,
          reasoning: "",
          reasoningSeen: false,
          toolActivities: [],
          status: "complete",
        }}
      />,
    );
    const table = await waitFor(() => container.querySelector("table")!);
    expect(table.querySelectorAll("tbody tr")).toHaveLength(30);
    // A table is read in full: nothing scrolls it inside the transcript's own scroll.
    expect((table.parentElement as HTMLElement).style.maxHeight).toBe("");
  });
});

describe("withLiveText", () => {
  const row: DisplayMessage = {
    id: "live",
    role: "assistant",
    content: "",
    reasoning: "",
    reasoningSeen: false,
    toolActivities: [],
    status: "streaming",
  };
  it("draws the paced text while the stream is live", () => {
    expect(withLiveText(row, "streaming", snapshot("Half an"))).toMatchObject({
      content: "Half an",
      status: "streaming",
      reasoning: "weighing it",
      reasoningSeen: true,
      rawTextLength: 12,
    });
  });

  it("keeps the longer text once finished, and the row's own once it caught up", () => {
    // The refetched row may still hold the partial text the stream outgrew.
    expect(withLiveText(row, "complete", snapshot("The whole answer"))).toMatchObject({
      content: "The whole answer",
      status: "complete",
    });
    const refetched = { ...row, content: "The whole answer", status: "complete" };
    expect(withLiveText(refetched, "error", snapshot("The whole"))).toMatchObject({
      content: "The whole answer",
      status: "complete",
    });
  });

  it("moves a placed card to the end of the text as it grows", () => {
    const placed = {
      family: "document",
      name: "create_document",
      status: "complete",
      callId: `${PLACED_CALL_PREFIX}doc-1`,
      textOffset: 0,
    } as ToolActivity;
    const drawn = withLiveText(
      { ...row, toolActivities: [placed] },
      "streaming",
      snapshot("Grown"),
    );
    expect(drawn.toolActivities[0]?.textOffset).toBe(5);
  });

  it("re-renders the live row on a pacing tick without a new message object", () => {
    vi.useFakeTimers();
    try {
      const text = createLiveText({ text: "", reasoning: "", reasoningSeen: false, lastSeq: 0 });
      const { container } = render(
        <MessageBubble message={{ ...row, liveStream: { text, status: "streaming" } }} />,
      );
      text.append("text", "Streamed straight into the row");
      expect(container).not.toHaveTextContent("Streamed");
      // Streaming words render as separate animated spans.
      act(() => vi.advanceTimersByTime(30 * 10));
      expect(container).toHaveTextContent("Streamed straight into the row");
    } finally {
      vi.useRealTimers();
    }
  });
});
