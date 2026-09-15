import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Analytics01Icon } from "@hugeicons/core-free-icons";
import { ErrorState, Page, Section, SectionShell } from "./page-shell.tsx";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: Record<string, unknown> & { children?: unknown }) => (
    <a href={String(to)} {...(rest as object)}>
      {children as never}
    </a>
  ),
  useMatches: () => [{ pathname: "/settings/usage" }],
}));

const scrollerOf = (element: Element | null) => {
  for (let node = element; node; node = node.parentElement)
    if (node.classList.contains("overflow-y-auto")) return node;
  return null;
};

// The app layout's <main> is a fixed-height flex child that never scrolls —
// the chat view relies on that. Every other route therefore has to bring its
// own scroll container, and Agents and Knowledge shipped without one once.
// Page owns it now, so a page built from Page scrolls by construction.
describe("Page", () => {
  it("lets page and section action groups wrap without adding scrollers", () => {
    render(
      <Page title="A long page title" actions={<button>Page action</button>}>
        <Section title="A long section title" actions={<button>Section action</button>}>
          <p>Body</p>
        </Section>
      </Page>,
    );
    for (const name of ["Page action", "Section action"]) {
      const group = screen.getByRole("button", { name }).parentElement!;
      expect(group).toHaveClass("flex-wrap", "max-w-full");
      expect(group.parentElement).toHaveClass("flex-wrap");
    }
    expect(scrollerOf(scrollerOf(screen.getByText("Body"))!.parentElement)).toBeNull();
  });

  it("is the one scroll container for its content, wherever it is mounted", () => {
    render(
      <Page title="Usage" rootPath="/settings" rootLabel="Settings">
        <p>Body</p>
      </Page>,
    );
    const scroller = scrollerOf(screen.getByText("Body"));
    expect(scroller).toHaveClass("h-full", "overflow-y-auto");
    expect(scroller).toContainElement(screen.getByRole("heading", { name: "Usage" }));
    expect(scrollerOf(scroller!.parentElement)).toBeNull();
  });

  it("does not gain a second scroller under a SectionShell", () => {
    render(
      <SectionShell
        title="Settings"
        rootPath="/settings"
        items={[
          {
            to: "/settings/usage",
            label: "Usage",
            icon: Analytics01Icon,
            matchPrefix: "/settings/usage",
          },
        ]}
      >
        <Page title="Usage" rootPath="/settings" rootLabel="Settings">
          <p>Body</p>
        </Page>
      </SectionShell>,
    );
    const scroller = scrollerOf(screen.getByText("Body"))!;
    expect(scroller).toHaveClass("overflow-y-auto");
    // Nothing above the Page scrolls: nested scrollers trap wheel events and
    // break sticky headers.
    expect(scrollerOf(scroller.parentElement)).toBeNull();
    // The shell column must be able to shrink so the Page's h-full is real.
    expect(scroller.parentElement).toHaveClass("min-h-0", "flex-1");
  });
});

describe("ErrorState", () => {
  it("keeps retry and a custom action on the same card", () => {
    render(
      <ErrorState
        title="Could not load this page"
        onRetry={() => {}}
        action={<button type="button">Back to chats</button>}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load this page");
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Back to chats" })).toBeVisible();
  });
});
