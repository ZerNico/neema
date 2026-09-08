import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "~/ui/primitives/tooltip";
import { CitationChip } from "./citation-chip.tsx";

const source = {
  kind: "web" as const,
  index: 1,
  url: "https://www.example.com/article",
  title: "A source title that stays readable in the preview",
  snippet: "Supporting context from the source.",
  read: true,
};

describe("CitationChip", () => {
  it("opens a stacked source preview immediately even inside a delayed provider", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider delay={1000}>
        <CitationChip source={source} />
      </TooltipProvider>,
    );
    const link = screen.getByRole("link", { name: `Source: ${source.title}` });
    expect(link.getAttribute("href")).toBe(source.url);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("title")).toBeNull();

    await user.hover(link);
    const preview = screen
      .getByText(source.snippet)
      .closest<HTMLElement>('[data-slot="tooltip-content"]')!;
    expect(within(preview).getByText(source.title)).toBeTruthy();
    expect(within(preview).getByText("example.com")).toBeTruthy();
    expect(within(preview).getByText(source.snippet)).toBeTruthy();
    expect(preview.classList.contains("block")).toBe(true);
    expect(preview.querySelector('[data-slot="tooltip-arrow"]')).toBeNull();
  });

  it("supports keyboard focus and Escape with a hostname-only source", async () => {
    const user = userEvent.setup();
    render(<CitationChip source={{ ...source, title: "", snippet: "" }} />);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Source: example.com" }));
    const preview = document.querySelector<HTMLElement>('[data-slot="tooltip-content"]')!;
    expect(within(preview).getAllByText("example.com")).toHaveLength(2);
    expect(preview.querySelectorAll("p")).toHaveLength(1);

    await user.keyboard("{Escape}");
    expect(document.querySelector('[data-slot="tooltip-content"][data-open]')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Source: example.com" }));
  });
});
