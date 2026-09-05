import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { WebToolActivity } from "../client/use-message-stream.ts";
import { ToolActivityBlock } from "./tool-activity-block.tsx";

const completeSearch: WebToolActivity = {
  family: "web",
  callId: "call-1",
  name: "web_search",
  targets: ["Effect 4", "Effect TypeScript"],
  status: "complete",
  resultCount: 1,
  sources: [
    {
      index: 1,
      url: "https://effect.website/blog",
      title: "Effect blog",
      snippet: "Effect news",
      read: false,
    },
  ],
};

const runningRead: WebToolActivity = {
  family: "web",
  callId: "call-2",
  name: "read_url",
  targets: ["https://effect.website/blog", "https://drizzle.team/docs"],
  status: "running",
  pages: [
    {
      url: "https://effect.website/blog",
      title: "Effect blog",
      status: "reading",
    },
    {
      url: "https://drizzle.team/docs",
      title: "Drizzle docs",
      status: "pending",
    },
  ],
};

const completeRead: WebToolActivity = {
  ...runningRead,
  status: "complete",
  pagesFetched: 2,
  pages: [
    {
      url: "https://effect.website/blog",
      title: "Effect blog",
      status: "done",
    },
    {
      url: "https://drizzle.team/docs",
      title: "Drizzle docs",
      status: "done",
    },
  ],
};

const toggle = () =>
  screen.getByRole("button", {
    name: /^(Searched|Searching|Opening|Reading|Read|Web search|Couldn’t)/i,
  });

describe("ToolActivityBlock", () => {
  it("shows search queries without repeating the result list", async () => {
    const user = userEvent.setup();
    const { container } = render(<ToolActivityBlock activities={[completeSearch]} />);

    expect(toggle()).toHaveAccessibleName("Searched the web · 1 source");
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Effect blog")).not.toBeInTheDocument();

    await user.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/Effect 4/)).toBeInTheDocument();
    expect(screen.queryByText("Effect blog")).not.toBeInTheDocument();
    expect(screen.queryByText("Effect news")).not.toBeInTheDocument();

    const panel = container.querySelector('[data-slot="collapsible-content"]');
    expect(panel).toHaveClass("transition-[height,opacity]");
    expect(panel).toHaveClass("data-ending-style:h-0");

    await user.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(screen.queryByText(/Effect 4/)).not.toBeInTheDocument());
  });

  it("bounds query and opened-page details and deduplicates source counts", async () => {
    const user = userEvent.setup();
    const search: WebToolActivity = {
      ...completeSearch,
      targets: ["first query", "second query", "third query"],
    };
    const read: WebToolActivity = {
      family: "web",
      callId: "call-many",
      name: "read_url",
      targets: [
        "https://effect.website/blog#section",
        "https://drizzle.team/docs",
        "https://tanstack.com/router",
        "https://react.dev/reference",
      ],
      status: "complete",
      pagesFetched: 4,
      pages: [
        { url: "https://effect.website/blog", title: "Effect blog", status: "done" },
        { url: "https://drizzle.team/docs", title: "Drizzle docs", status: "done" },
        { url: "https://tanstack.com/router", title: "TanStack Router", status: "done" },
        { url: "https://react.dev/reference", title: "React reference", status: "done" },
      ],
      sources: [
        {
          index: 1,
          url: "https://effect.website/blog",
          title: "Effect blog",
          snippet: "",
          read: true,
        },
      ],
    };

    render(<ToolActivityBlock activities={[search, read]} />);

    expect(toggle()).toHaveAccessibleName("Searched the web · 1 source");
    await user.click(toggle());

    expect(screen.getByText(/“first query” and “second query”, \+1 more/)).toBeInTheDocument();
    expect(screen.queryByText("third query")).not.toBeInTheDocument();
    expect(screen.getByText("Effect blog")).toBeInTheDocument();
    expect(screen.getByText("Drizzle docs")).toBeInTheDocument();
    expect(screen.getByText("TanStack Router")).toBeInTheDocument();
    expect(screen.queryByText("React reference")).not.toBeInTheDocument();
    expect(screen.getByText("+1 more opened")).toBeInTheDocument();
  });

  it("shows live page progress and auto-collapses when reading finishes", async () => {
    const { rerender } = render(<ToolActivityBlock activities={[runningRead]} />);

    expect(toggle()).toHaveAccessibleName("Reading sources…");
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Effect blog")).toBeInTheDocument();
    expect(screen.getByText("reading…")).toBeInTheDocument();
    expect(screen.getByText("Drizzle docs")).toBeInTheDocument();
    expect(screen.getByText("queued")).toBeInTheDocument();

    rerender(<ToolActivityBlock activities={[completeRead]} />);

    expect(toggle()).toHaveAccessibleName("Read 2 pages");
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    await waitFor(
      () => {
        expect(toggle()).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByText("Effect blog")).not.toBeInTheDocument();
      },
      { timeout: 1_500 },
    );
  });

  it("stays open across a completed-search gap before reading begins", () => {
    const runningSearch: WebToolActivity = {
      ...completeSearch,
      status: "running",
      sources: [],
    };
    const { rerender } = render(<ToolActivityBlock activities={[runningSearch]} />);

    expect(toggle()).toHaveAttribute("aria-expanded", "true");

    rerender(<ToolActivityBlock activities={[completeSearch]} />);
    expect(toggle()).toHaveAttribute("aria-expanded", "true");

    rerender(<ToolActivityBlock activities={[completeSearch, runningRead]} />);
    expect(toggle()).toHaveAccessibleName("Reading sources…");
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
  });

  it("only offers the source-panel action after completion", async () => {
    const user = userEvent.setup();
    const onViewSources = vi.fn();
    const { rerender } = render(
      <ToolActivityBlock activities={[runningRead]} onViewSources={onViewSources} />,
    );

    expect(screen.queryByRole("button", { name: "View all sources" })).toBeNull();

    rerender(
      <ToolActivityBlock
        activities={[
          {
            ...completeRead,
            sources: [
              {
                index: 1,
                url: "https://effect.website/blog",
                title: "Effect blog",
                snippet: "Effect news",
                read: true,
              },
            ],
          },
        ]}
        onViewSources={onViewSources}
      />,
    );
    await user.click(screen.getByRole("button", { name: "View all sources" }));

    expect(onViewSources).toHaveBeenCalledOnce();
  });

  it("scopes manual disclosure choices to the running or completed phase", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ToolActivityBlock activities={[runningRead]} />);

    await user.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");

    rerender(<ToolActivityBlock activities={[completeRead]} />);
    expect(toggle()).toHaveAttribute("aria-expanded", "false");

    await user.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "true");

    rerender(<ToolActivityBlock activities={[runningRead]} />);
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
  });
});
