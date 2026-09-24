import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HeaderSlot, HeaderSlotProvider } from "~/ui/header-slot.tsx";
import { keepConversation } from "../server/functions.ts";
import { ConversationCrumbs } from "./conversation-crumbs.tsx";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params: _params, children, ...rest }: Record<string, unknown>) => (
    <a href={String(to)} {...(rest as object)}>
      {children as never}
    </a>
  ),
}));

vi.mock("../server/functions.ts", () => ({ keepConversation: vi.fn(async () => {}) }));

vi.mock("~/modules/schedules/server/functions.ts", () => ({
  getSchedule: vi.fn(),
  listSchedules: vi.fn(),
  listScheduleRuns: vi.fn(),
}));

const renderCrumbs = (props: Partial<Parameters<typeof ConversationCrumbs>[0]>) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <HeaderSlotProvider>
        <header>
          <HeaderSlot />
        </header>
        <ConversationCrumbs
          conversationId="c1"
          title="Weekly digest"
          schedule={null}
          branchedFrom={null}
          agent={null}
          {...props}
        />
      </HeaderSlotProvider>
    </QueryClientProvider>,
  );

describe("ConversationCrumbs", () => {
  it("puts the title in the header, untagged for a plain chat", () => {
    renderCrumbs({});
    const header = screen.getByRole("banner");
    expect(header).toHaveTextContent(/^Weekly digest$/);
  });

  it("shows an untitled chat as pending, like the sidebar", () => {
    renderCrumbs({ title: null });
    expect(screen.getByLabelText("Generating title")).toHaveTextContent("New chat…");
  });

  it("tags the installed agent without linking to its owner's editor", () => {
    renderCrumbs({ agent: { id: "a1", name: "Reviewer", icon: "code" } });
    expect(screen.getByText("Reviewer")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("keeps an agent that no longer resolves visible as unavailable", () => {
    renderCrumbs({ agent: { id: "gone", name: null } });
    expect(screen.getByText("Agent unavailable")).toBeInTheDocument();
  });

  it("links the schedule that runs in this chat", () => {
    renderCrumbs({ schedule: { scheduleId: "s1", name: "wqd", runsHere: true } });
    expect(screen.getByRole("link", { name: /^Schedule running here\s?wqd$/ })).toHaveAttribute(
      "href",
      "/schedules/$scheduleId",
    );
  });

  it("marks a temporary chat and keeps it on request", async () => {
    renderCrumbs({ temporary: true });
    expect(screen.getByText("Temporary")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Keep chat" }));
    await waitFor(() =>
      expect(keepConversation).toHaveBeenCalledWith({ data: { conversationId: "c1" } }),
    );
  });

  it("offers no Keep on an ordinary chat", () => {
    renderCrumbs({});
    expect(screen.queryByRole("button", { name: "Keep chat" })).toBeNull();
  });
});
