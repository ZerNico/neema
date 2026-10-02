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
      kind: "web" as const,
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
    name: /^(Searched|Searching|Opening|Reading|Read|Couldn’t)/i,
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
        "https://vitest.dev/guide",
      ],
      status: "complete",
      pagesFetched: 5,
      pages: [
        { url: "https://effect.website/blog", title: "Effect blog", status: "done" },
        { url: "https://drizzle.team/docs", title: "Drizzle docs", status: "done" },
        { url: "https://tanstack.com/router", title: "TanStack Router", status: "done" },
        { url: "https://react.dev/reference", title: "React reference", status: "done" },
        { url: "https://vitest.dev/guide", title: "Vitest guide", status: "done" },
      ],
      sources: [
        {
          kind: "web" as const,
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

    expect(screen.getByText("first query")).toBeInTheDocument();
    expect(screen.getByText("third query")).toBeInTheDocument();
    expect(screen.getByText("Effect blog")).toBeInTheDocument();
    expect(screen.getByText("Drizzle docs")).toBeInTheDocument();
    expect(screen.getByText("TanStack Router")).toBeInTheDocument();
    expect(screen.getByText("React reference")).toBeInTheDocument();
    expect(screen.queryByText("Vitest guide")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show 1 more" }));
    expect(screen.getByText("Vitest guide")).toBeInTheDocument();
  });

  it("names what it reads while running, and never opens by itself", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ToolActivityBlock activities={[runningRead]} />);

    expect(toggle()).toHaveAccessibleName("Reading effect.website");
    expect(toggle()).toHaveAttribute("aria-expanded", "false");

    await user.click(toggle());
    expect(screen.getByText("Effect blog")).toHaveClass("text-shimmer");
    expect(screen.getByText("Drizzle docs")).toBeInTheDocument();

    rerender(<ToolActivityBlock activities={[completeRead]} />);
    expect(toggle()).toHaveAccessibleName("Read 2 pages");
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
  });

  it("names the running query, and shows a failed page without a tick on the others", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ToolActivityBlock activities={[{ ...completeSearch, status: "running", sources: [] }]} />,
    );
    expect(toggle()).toHaveAccessibleName("Searching for “Effect TypeScript”");
    expect(toggle()).toHaveAttribute("aria-expanded", "false");

    rerender(
      <ToolActivityBlock
        activities={[
          {
            ...completeRead,
            pages: [
              { url: "https://effect.website/blog", title: "Effect blog", status: "done" },
              { url: "https://drizzle.team/docs", title: "Drizzle docs", status: "error" },
            ],
          },
        ]}
      />,
    );
    await user.click(toggle());
    expect(screen.getAllByText("Couldn’t open")).toHaveLength(1);
    expect(screen.getByText("Drizzle docs").closest("li")).toHaveTextContent("Couldn’t open");
    expect(screen.getByText("Effect blog").closest("li")).not.toHaveTextContent("Couldn’t open");
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
                kind: "web" as const,
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
    await user.click(toggle());
    await user.click(screen.getByRole("button", { name: "View all sources" }));

    expect(onViewSources).toHaveBeenCalledOnce();
  });
});
