import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopToolActivity } from "../client/use-message-stream.ts";
import { BrowserActivityBlock } from "./browser-activity-block.tsx";
import { AppMotionProvider } from "~/ui/motion.tsx";

vi.stubGlobal(
  "matchMedia",
  vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
);

let calls = 0;
const step = (
  name: DesktopToolActivity["name"],
  summary: string,
  page?: { url: string; title: string },
  overrides: Partial<DesktopToolActivity> = {},
): DesktopToolActivity => ({
  family: "desktop",
  callId: `call-${++calls}`,
  name,
  status: "complete",
  turnIndex: 0,
  callIndex: calls,
  args: {},
  result: {
    v: 1,
    ok: overrides.status !== "error",
    summary,
    detail: "t1: written for the model, never shown",
    truncated: false,
    ...(page ? { page } : {}),
  },
  ...overrides,
});
const block = (
  activities: DesktopToolActivity[],
  approvals?: Parameters<typeof BrowserActivityBlock>[0]["approvals"],
) => (
  <QueryClientProvider client={client}>
    <AppMotionProvider>
      <BrowserActivityBlock activities={activities} approvals={approvals} />
    </AppMotionProvider>
  </QueryClientProvider>
);
const client = new QueryClient();
const show = (
  activities: DesktopToolActivity[],
  approvals?: Parameters<typeof BrowserActivityBlock>[0]["approvals"],
) => render(block(activities, approvals));

const example = { url: "https://example.com/", title: "Example Domain" };
const iana = { url: "https://www.iana.org/domains", title: "Domain Name Services" };

describe("browser activity block", () => {
  it("collapses a run into one row naming the sites, and lists the steps on demand", () => {
    show([
      step("browser_open", "Opened example.com", example),
      step("browser_click", "Clicked the “Learn more” link", iana),
      step("browser_scroll", "Scrolled down", iana),
    ]);
    const header = screen.getByRole("button", { name: /Browsed example\.com and iana\.org/ });
    fireEvent.click(header);
    expect(screen.getByText("Clicked the “Learn more” link")).toBeInTheDocument();
    // Each page is linked once, where the run reached it.
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Example Domain",
      "Domain Name Services",
    ]);
    // What the model read stays out of the transcript.
    expect(screen.queryByText(/written for the model/)).not.toBeInTheDocument();
  });

  it("says it waits on the user, and leaves the question to the dock", () => {
    const { result: _none, ...click } = step("browser_click", "", undefined, {
      status: "running",
      args: { ref: "e1" },
    });
    show(
      [step("browser_open", "Opened example.com", example), click],
      new Map([
        [
          click.callId,
          {
            kind: "browser-action",
            args: { ref: "e1", target: 'link "Learn more"' },
            decide: vi.fn(),
          },
        ],
      ]),
    );
    expect(screen.getByText("Waiting for you")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument();
  });

  it("stays folded while running, since the work line around it is what opens", () => {
    const { result: _none, ...open } = step("browser_open", "", undefined, {
      status: "running",
      args: { url: "https://example.com" },
    });
    show([open]);
    const header = screen.getAllByRole("button")[0]!;
    expect(header).toHaveAttribute("aria-expanded", "false");
  });

  it("owns up when nothing worked", () => {
    show([step("browser_open", "You didn’t allow c.test", undefined, { status: "error" })]);
    expect(screen.getByText("Couldn’t use the browser")).toBeInTheDocument();
  });
});
