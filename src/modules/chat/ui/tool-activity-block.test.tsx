import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
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

const toggle = () => screen.getByRole("button", { name: /web|sources|pages/i });

describe("ToolActivityBlock", () => {
  it("lets a completed search expand to its snippet-only result rows", async () => {
    const user = userEvent.setup();
    const { container } = render(<ToolActivityBlock activities={[completeSearch]} />);

    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Effect blog")).not.toBeInTheDocument();

    await user.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Effect blog")).toBeInTheDocument();
    expect(screen.getByText(/Effect 4/)).toBeInTheDocument();

    const panel = container.querySelector('[data-slot="collapsible-content"]');
    expect(panel).toHaveClass("transition-[height,opacity]");
    expect(panel).toHaveClass("data-ending-style:h-0");

    await user.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(screen.queryByText("Effect blog")).not.toBeInTheDocument());
  });

  it("shows every page while a batched read runs, then auto-collapses", async () => {
    const { rerender } = render(<ToolActivityBlock activities={[runningRead]} />);

    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Effect blog")).toBeInTheDocument();
    expect(screen.getByText("Drizzle docs")).toBeInTheDocument();

    rerender(<ToolActivityBlock activities={[completeRead]} />);

    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(screen.queryByText("Effect blog")).not.toBeInTheDocument());
  });

  it("hides completed sibling rows while another call in the turn is running", () => {
    const searchOnly = {
      ...completeSearch,
      sources: [
        {
          index: 2,
          url: "https://example.com/search-only",
          title: "Search-only result",
          snippet: "Only the search returned this row",
          read: false,
        },
      ],
    };

    render(<ToolActivityBlock activities={[searchOnly, runningRead]} />);

    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByText("Search-only result")).not.toBeInTheDocument();
    expect(screen.getByText("Drizzle docs")).toBeInTheDocument();
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
