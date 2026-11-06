import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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
const client = new QueryClient();
const show = (activities: DesktopToolActivity[]) =>
  render(
    <QueryClientProvider client={client}>
      <AppMotionProvider>
        <BrowserActivityBlock activities={activities} />
      </AppMotionProvider>
    </QueryClientProvider>,
  );

const example = { url: "https://example.com/", title: "Example Domain" };
const iana = { url: "https://www.iana.org/domains", title: "Domain Name Services" };

describe("browser activity block", () => {
  it("lists each step as its own line and links each page once, where the run reached it", () => {
    show([
      step("browser_open", "Opened example.com", example),
      step("browser_click", "Clicked the “Learn more” link", iana),
      step("browser_scroll", "Scrolled down", iana),
    ]);
    expect(screen.getByText("Opened example.com")).toBeInTheDocument();
    expect(screen.getByText("Clicked the “Learn more” link")).toBeInTheDocument();
    expect(screen.getByText("Scrolled down")).toBeInTheDocument();
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Example Domain",
      "Domain Name Services",
    ]);
    // What the model read stays out of the transcript.
    expect(screen.queryByText(/written for the model/)).not.toBeInTheDocument();
  });

  it("keeps a finished step's own line between calls, rather than a summary of the sites", () => {
    const { result: _none, ...open } = step("browser_open", "", undefined, {
      status: "running",
      args: { url: "https://example.com" },
    });
    const { rerender } = show([open]);
    expect(screen.getByText(/Opening example\.com/)).toBeInTheDocument();
    rerender(
      <QueryClientProvider client={client}>
        <AppMotionProvider>
          <BrowserActivityBlock
            activities={[
              step("browser_open", "Opened example.com", example, { callId: open.callId }),
            ]}
          />
        </AppMotionProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByText("Opened example.com")).toBeInTheDocument();
    expect(screen.queryByText(/Browsed/)).not.toBeInTheDocument();
  });

  it("links nothing again when the run before it already reached the page", () => {
    render(
      <QueryClientProvider client={client}>
        <AppMotionProvider>
          <BrowserActivityBlock
            activities={[
              step("browser_click", "Clicked “Reply”", iana),
              step("browser_open", "Opened example.com", example),
            ]}
            pageBefore={iana.url}
          />
        </AppMotionProvider>
      </QueryClientProvider>,
    );
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(["Example Domain"]);
  });

  it("says what failed on the step that failed", () => {
    show([step("browser_open", "You didn’t allow c.test", undefined, { status: "error" })]);
    expect(screen.getByText("You didn’t allow c.test")).toBeInTheDocument();
  });
});
