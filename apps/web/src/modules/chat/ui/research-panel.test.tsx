import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  KnowledgeToolActivity,
  ResearchToolActivity,
  WebToolActivity,
} from "../client/use-message-stream.ts";
import { MessageBubble, type DisplayMessage } from "./message-list.tsx";
import { ResearchActivityBody, ResearchPanelOwner } from "./research-panel.tsx";
import type { ResearchTaskProgress } from "../research-schema.ts";
import { DetailPanelProvider, DetailPanelRail, DetailPanelToggle } from "~/ui/detail-panel.tsx";
import { AppMotionProvider } from "~/ui/motion.tsx";

// The panel closes on navigation; these tests render outside a router.
const environment = vi.hoisted(() => ({ pathname: "/chat/test" }));
vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: environment.pathname }, matches: [] }),
}));
beforeEach(() => {
  environment.pathname = "/chat/test";
});

const source = {
  kind: "web" as const,
  index: 1,
  url: "https://example.org/report",
  title: "Evidence",
  snippet: "Finding",
  read: true,
};
const research: ResearchToolActivity = {
  family: "research",
  callId: "run-1",
  runId: "run-1",
  name: "deep_research",
  status: "running",
  textOffset: 0,
  turnIndex: 0,
  callIndex: 0,
  progress: {
    runId: "run-1",
    phase: "researching",
    usageComplete: true,
    limitations: [],
    tasks: [
      { id: "task-2", ordinal: 2, title: "Second topic", status: "queued" },
      {
        id: "task-1",
        ordinal: 1,
        title: "First topic",
        status: "running",
      },
    ],
  },
};
const search: WebToolActivity = {
  family: "web",
  callId: "web-1",
  runId: "run-1",
  taskId: "task-1",
  name: "web_search",
  status: "complete",
  targets: ["primary evidence"],
  resultCount: 20,
  sources: [source],
};
const read: WebToolActivity = {
  family: "web",
  callId: "web-2",
  runId: "run-1",
  taskId: "task-1",
  name: "read_url",
  status: "running",
  targets: ["https://example.org/report"],
};

const message = {
  id: "m1",
  role: "assistant" as const,
  content: "",
  reasoning: "",
  reasoningSeen: false,
  status: "streaming",
  toolActivities: [research, search, read] as DisplayMessage["toolActivities"],
};

const tree = (
  toolActivities = message.toolActivities,
  status = message.status,
  content = message.content,
  options: {
    visible?: boolean;
    id?: string;
    removed?: boolean;
  } = {},
) => {
  const display = { ...message, status, content, toolActivities, ...options };
  return (
    <StrictMode>
      <AppMotionProvider>
        <DetailPanelProvider>
          <main>
            <ResearchPanelOwner messages={options.removed ? [] : [display]} />
            {options.visible !== false && !options.removed ? (
              <MessageBubble message={display} />
            ) : null}
          </main>
          {/* The real rail is outside ChatView, not a child of the virtual list. */}
          <DetailPanelRail />
          <DetailPanelToggle />
        </DetailPanelProvider>
      </AppMotionProvider>
    </StrictMode>
  );
};
const renderBubble = (...args: Parameters<typeof tree>) => render(tree(...args));

describe("research panel", () => {
  // The rail picks desktop or sheet by media query; jsdom has none.
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  it("opens the live investigation from the card as milestones, each step one click away", () => {
    renderBubble();
    fireEvent.click(screen.getByRole("button", { name: /Deep research/ }));
    const panel = screen.getByRole("complementary", { name: "Deep research" });
    expect(within(panel).getByText("In progress")).toBeInTheDocument();
    // A started topic says what it is on now; one not started yet sits in the plan.
    expect(within(panel).getByText("First topic")).toBeInTheDocument();
    expect(within(panel).getByText("Reading example.org")).toBeInTheDocument();
    expect(within(panel).queryByText("Second topic")).not.toBeInTheDocument();
    expect(within(panel).queryByText("primary evidence")).not.toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: /Made a plan/ }));
    const plan = within(panel)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(plan.indexOf("First topic")).toBeLessThan(plan.indexOf("Second topic"));
    fireEvent.click(within(panel).getByRole("button", { name: /First topic/ }));
    expect(within(panel).getByText("primary evidence")).toBeInTheDocument();
    expect(within(panel).getByText(/20 results/)).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: /example\.org/ })).toHaveAttribute(
      "href",
      "https://example.org/report",
    );
    // The body itself has no tabs; the panel's own tab strip sits above it.
    expect(within(within(panel).getByRole("tabpanel")).queryByRole("tab")).not.toBeInTheDocument();
  });

  it("lists knowledge steps under their task by outcome, never by document handle", () => {
    const listing: KnowledgeToolActivity = {
      family: "knowledge",
      callId: "k-1",
      runId: "run-1",
      taskId: "task-1",
      name: "list_knowledge_documents",
      status: "complete",
      summary: {
        targets: [],
        documentsListed: 3,
        passagesReturned: 0,
        remainingOps: 63,
        coverage: "",
      },
    };
    const bothRunning: ResearchToolActivity = {
      ...research,
      progress: {
        ...research.progress!,
        tasks: research.progress!.tasks.map((task) =>
          task.id === "task-2" ? Object.assign({}, task, { status: "running" as const }) : task,
        ),
      },
    };
    const reading: KnowledgeToolActivity = {
      family: "knowledge",
      callId: "k-2",
      runId: "run-1",
      taskId: "task-2",
      name: "read_knowledge_document",
      status: "running",
    };
    const strayRun: KnowledgeToolActivity = { ...reading, callId: "k-3", runId: "other-run" };
    renderBubble([bothRunning, search, listing, reading, strayRun]);
    // The stray activity belongs to another run, so it renders as an ordinary
    // knowledge row beside the card and never inside the panel.
    expect(screen.getByRole("button", { name: /Reading documents/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Deep research/ }));
    const panel = screen.getByRole("complementary", { name: "Deep research" });
    expect(within(panel).getByText("Reading documents")).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: /First topic/ }));
    expect(within(panel).getByText("Listed 3 documents")).toBeInTheDocument();
    expect(within(panel).getByText("In progress")).toBeInTheDocument();
    expect(within(panel).queryByText(/version/)).not.toBeInTheDocument();
    const first = within(panel).getByText("First topic");
    const listed = within(panel).getByText("Listed 3 documents");
    const second = within(panel).getByText("Second topic");
    expect(first.compareDocumentPosition(listed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(listed.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("follows progress after the opening bubble unmounts in StrictMode", async () => {
    const { rerender } = renderBubble();
    fireEvent.click(screen.getByRole("button", { name: /Deep research/ }));
    const panel = screen.getByRole("complementary", { name: "Deep research" });
    expect(within(panel).queryByText("Second topic")).not.toBeInTheDocument();
    // Virtualization evicts the opening bubble before the next stream chunk.
    rerender(tree(undefined, undefined, undefined, { visible: false }));
    expect(screen.queryByRole("button", { name: /source so far/ })).not.toBeInTheDocument();
    expect(within(panel).getByText("First topic")).toBeInTheDocument();
    const later: WebToolActivity = {
      ...search,
      callId: "web-3",
      taskId: "task-2",
      targets: ["follow-up evidence"],
    };
    rerender(
      tree(
        [
          {
            ...research,
            progress: {
              ...research.progress!,
              tasks: research.progress!.tasks.map((task) =>
                task.id === "task-2"
                  ? Object.assign({}, task, { status: "running" as const })
                  : task,
              ),
            },
          },
          search,
          { ...read, status: "complete" },
          later,
        ],
        undefined,
        undefined,
        { visible: false },
      ),
    );
    // The topic joins the story when work on it starts, saying what it is on.
    await waitFor(() =>
      expect(within(panel).getByText("Searching “follow-up evidence”")).toBeInTheDocument(),
    );
    expect(within(panel).getByText("Second topic")).toBeInTheDocument();
  });

  it("settles the header and shows terminal failures with the bubble unmounted", () => {
    const { rerender } = renderBubble();
    fireEvent.click(screen.getByRole("button", { name: /Deep research/ }));
    const panel = screen.getByRole("complementary", { name: "Deep research" });
    expect(within(panel).getByText("In progress")).toBeInTheDocument();
    rerender(
      tree(
        [
          {
            ...research,
            status: "error",
            progress: {
              ...research.progress!,
              phase: "error",
              limitations: ["No usable research reports were produced."],
              tasks: research.progress!.tasks.map((task) =>
                Object.assign({}, task, {
                  status: "error" as const,
                  error: "The model returned no report for this task.",
                }),
              ),
            },
          },
          search,
          { ...read, status: "complete" },
        ],
        "complete",
        undefined,
        { visible: false },
      ),
    );
    expect(within(panel).queryByText("In progress")).not.toBeInTheDocument();
    expect(within(panel).getByText("2 steps")).toBeInTheDocument();
    expect(within(panel).getAllByText("Couldn’t finish this one")).toHaveLength(2);
    // Diagnostics are for the model and the run record, never the reader:
    // the panel says what it means in one sentence and drops the rest.
    expect(within(panel).queryByText(/returned no report/)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/No usable research reports/)).not.toBeInTheDocument();
    expect(within(panel).queryByText("Limitations")).not.toBeInTheDocument();
    expect(
      within(panel).getByText("The research didn’t turn up anything usable."),
    ).toBeInTheDocument();
  });

  it("summarises expected provider hiccups in plain words and stays quiet about accounting", () => {
    const { rerender } = renderBubble();
    fireEvent.click(screen.getByRole("button", { name: /Deep research/ }));
    const panel = screen.getByRole("complementary", { name: "Deep research" });
    const finished = (tasks: ResearchTaskProgress[], limitations: string[]) =>
      tree(
        [
          {
            ...research,
            status: "complete",
            progress: {
              ...research.progress!,
              phase: "error",
              usageComplete: false,
              limitations,
              tasks,
            },
          },
          search,
          { ...read, status: "complete" },
        ],
        "complete",
        "Final answer",
        { visible: false },
      );
    rerender(
      finished(
        [
          { id: "task-2", ordinal: 2, title: "Second topic", status: "error" },
          { id: "task-1", ordinal: 1, title: "First topic", status: "complete" },
        ],
        [
          "Task 2: A research provider request failed (InvalidOutputError). Some coverage is missing.",
          "Task 1: report reached the model output limit; some findings may be incomplete.",
          "Usage is incomplete: one or more provider calls ended without confirmed usage.",
        ],
      ),
    );
    expect(within(panel).getByText("Couldn’t finish this one")).toBeInTheDocument();
    expect(within(panel).getByText("First topic")).toBeInTheDocument();
    expect(
      within(panel).getByText("One topic couldn’t be finished, so some of this may be missing."),
    ).toBeInTheDocument();
    expect(within(panel).queryByText(/InvalidOutputError/)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/output limit/)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/usage/i)).not.toBeInTheDocument();
    // A truncated report on an otherwise finished task is the answer's job to
    // disclose where it matters; the panel does not repeat it.
    rerender(
      finished(
        [{ id: "task-1", ordinal: 1, title: "First topic", status: "complete" }],
        ["Task 1: report reached the model output limit; some findings may be incomplete."],
      ),
    );
    expect(within(panel).queryByText(/coverage/)).not.toBeInTheDocument();
  });

  it("settles at synthesis and keeps the final activity after completion without a bubble", () => {
    const { rerender } = renderBubble();
    fireEvent.click(screen.getByRole("button", { name: /Deep research/ }));
    const panel = screen.getByRole("complementary", { name: "Deep research" });
    rerender(tree(undefined, undefined, undefined, { visible: false }));
    const settled: ResearchToolActivity = {
      ...research,
      status: "complete",
      progress: {
        ...research.progress!,
        phase: "complete",
        tasks: research.progress!.tasks.map((task) =>
          Object.assign({}, task, { status: "complete" as const }),
        ),
      },
    };
    const tools = [settled, search, { ...read, status: "complete" as const }];
    rerender(tree(tools, "streaming", "Answer starts", { visible: false }));
    expect(within(panel).queryByText("In progress")).not.toBeInTheDocument();
    expect(within(panel).getByText("2 steps")).toBeInTheDocument();
    expect(within(panel).getByText("Second topic")).toBeInTheDocument();
    expect(within(panel).queryByText("and counting")).not.toBeInTheDocument();
    rerender(
      tree(
        [
          {
            ...settled,
            status: "complete",
            progress: { ...settled.progress!, phase: "complete", usageComplete: false },
          },
          search,
          { ...read, status: "complete" },
        ],
        "complete",
        "Final answer",
        { visible: false },
      ),
    );
    expect(screen.getByRole("complementary", { name: "Deep research" })).toBe(panel);
    expect(within(panel).getByText("2 steps")).toBeInTheDocument();
    expect(within(panel).queryByText(/usage/i)).not.toBeInTheDocument();
  });

  it("shows what a finished topic found, and nothing for one still running or failed", () => {
    renderBubble([
      {
        ...research,
        progress: {
          ...research.progress!,
          tasks: [
            {
              id: "task-1",
              ordinal: 1,
              title: "First topic",
              status: "complete",
              finding: "Two clinics take new patients.",
            },
            { id: "task-2", ordinal: 2, title: "Second topic", status: "running" },
            {
              id: "task-3",
              ordinal: 3,
              title: "Third topic",
              status: "error",
              finding: "Never shown for a topic that failed.",
            },
          ],
        },
      },
      { ...search, status: "complete" },
      { ...read, status: "complete" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: /Deep research/ }));
    const panel = screen.getByRole("complementary", { name: "Deep research" });
    const title = within(panel).getByText("First topic");
    const finding = within(panel).getByText("Two clinics take new patients.");
    expect(title.compareDocumentPosition(finding) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // It sits inside the topic's own trigger, so the topic still opens on click.
    expect(finding.closest("button")).toBe(title.closest("button"));
    expect(within(panel).queryByText(/Never shown/)).not.toBeInTheDocument();
    expect(within(panel).getByText("Couldn’t finish this one")).toBeInTheDocument();
  });

  it("opens while the brief is still being written and follows the run that replaces it", () => {
    const starting: ResearchToolActivity = {
      family: "research",
      callId: "writing:call-1",
      name: "deep_research",
      status: "running",
      textOffset: 0,
      turnIndex: 0,
      callIndex: Number.MAX_SAFE_INTEGER,
      writing: true,
    };
    const { rerender } = renderBubble([starting]);
    fireEvent.click(screen.getByRole("button", { name: /Planning what to look into/ }));
    const panel = screen.getByRole("complementary", { name: "Deep research" });
    expect(within(panel).getByText("Planning what to look into")).toBeInTheDocument();
    // The started run takes the placeholder's place, so the open panel stays on it.
    rerender(tree([research, search, read]));
    const live = screen.getByRole("complementary", { name: "Deep research" });
    expect(within(live).getByText("First topic")).toBeInTheDocument();
    // A retry's own placeholder at the same position is not this run.
    rerender(tree([{ ...starting, callId: "writing:call-2" }]));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("closes the old run on retry", () => {
    const { rerender } = renderBubble();
    fireEvent.click(screen.getByRole("button", { name: /Deep research/ }));
    const fresh: ResearchToolActivity = {
      ...research,
      callId: "run-2",
      runId: "run-2",
      progress: { ...research.progress!, runId: "run-2" },
    };
    // Retry reuses the message id. The panel follows the chosen call, so a run
    // the retry replaced has no activity left to render from. Stale chunks
    // never arrive: the stream itself is fenced by the generation.
    rerender(tree([fresh]));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Deep research/ }));
    expect(screen.getByRole("complementary", { name: "Deep research" })).toBeInTheDocument();
  });

  it("does not reopen after explicit close and subsequent progress", () => {
    const { rerender } = renderBubble();
    fireEvent.click(screen.getByRole("button", { name: /Deep research/ }));
    fireEvent.click(screen.getByRole("button", { name: "Hide panel" }));
    rerender(
      tree([research, search, { ...read, status: "complete" }], undefined, undefined, {
        visible: false,
      }),
    );
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("closes when the selected message disappears, not following a matching run on another message", () => {
    const { rerender } = renderBubble();
    fireEvent.click(screen.getByRole("button", { name: /Deep research/ }));
    rerender(tree(undefined, undefined, undefined, { id: "another-message" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Deep research/ }));
    rerender(tree(undefined, undefined, undefined, { removed: true }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("closes on conversation navigation without reopening on a late activity update", () => {
    const { rerender } = renderBubble();
    fireEvent.click(screen.getByRole("button", { name: /Deep research/ }));
    environment.pathname = "/chat/another";
    rerender(tree([research, search, { ...read, status: "complete" }]));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    rerender(tree());
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("keeps the sources list a separate snapshot after switching away from research", () => {
    const finished: ResearchToolActivity = {
      ...research,
      status: "complete",
      sources: [source],
      progress: { ...research.progress!, phase: "complete" },
    };
    const { rerender } = renderBubble(
      [finished, { ...search }, { ...read, status: "complete" }],
      "complete",
      "Answer with evidence[^1].",
    );
    fireEvent.click(screen.getByRole("button", { name: /Deep research/ }));
    expect(
      within(screen.getByRole("complementary", { name: "Deep research" })).getByText("2 steps"),
    ).toBeInTheDocument();
    // The chip links straight to the page; the list is reached from the menu.
    expect(screen.getByRole("link", { name: "Source: Evidence" })).toHaveAttribute(
      "href",
      "https://example.org/report",
    );
    fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /View sources/ }));
    const sources = screen.getByRole("complementary", { name: "Sources" });
    expect(within(sources).getByRole("link", { name: /Evidence/ })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Deep research" })).not.toBeInTheDocument();
    rerender(
      tree([research, { ...search, targets: ["late progress"] }, read], undefined, undefined, {
        visible: false,
      }),
    );
    expect(screen.getByRole("complementary", { name: "Sources" })).toBe(sources);
    expect(within(sources).getByRole("link", { name: /Evidence/ })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Deep research" })).not.toBeInTheDocument();
  });
});

describe("the research overview", () => {
  it("sums the run's sources by site behind its milestone, with no tick on a page that loaded", () => {
    const source = (index: number, url: string) => ({
      kind: "web" as const,
      index,
      url,
      title: url,
      snippet: "",
      read: false,
    });
    render(
      <AppMotionProvider>
        <ResearchActivityBody
          running={false}
          progress={undefined}
          webActivities={[
            {
              family: "web",
              callId: "s-1",
              name: "web_search",
              status: "complete",
              targets: ["hormone therapy berlin"],
              resultCount: 3,
              sources: [
                source(1, "https://awmf.org/a"),
                source(2, "https://awmf.org/b"),
                source(3, "https://bfarm.de/x"),
              ],
            },
            {
              family: "web",
              callId: "r-1",
              name: "read_url",
              status: "complete",
              targets: ["https://awmf.org/a"],
            },
          ]}
        />
      </AppMotionProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "3 sources" }));
    const sites = within(screen.getByRole("list", { name: "Sources by site" }))
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(sites).toEqual(["awmf.org2 sources", "bfarm.de1 source"]);
    // Steps outside any topic still have a place, behind their own milestone.
    fireEvent.click(screen.getByRole("button", { name: /Other steps/ }));
    expect(screen.getByText("Read a page")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "awmf.org" })).toHaveAttribute(
      "href",
      "https://awmf.org/a",
    );
    expect(document.querySelector(".text-success")).toBeNull();
  });
});
