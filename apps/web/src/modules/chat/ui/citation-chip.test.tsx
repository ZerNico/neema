import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DetailPanelProvider } from "~/ui/detail-panel.tsx";
import { CitationChip } from "./citation-chip.tsx";

// The detail panel reads the current path; nothing here navigates.
vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: "/chat/test" }, matches: [] }),
}));

const source = {
  kind: "web" as const,
  index: 1,
  url: "https://www.example.com/article",
  title: "A source title that stays readable in the preview",
  snippet: "Supporting context from the source.",
  read: true,
};

const preview = () => document.querySelector<HTMLElement>('[data-slot="hover-card-content"]');

describe("CitationChip", () => {
  it("opens a preview immediately on hover whose source is itself a link", async () => {
    const user = userEvent.setup();
    render(<CitationChip source={source} />);
    const chip = screen.getByRole("link", { name: `Source: ${source.title}` });
    expect(chip).toHaveAttribute("href", source.url);
    expect(chip).toHaveAttribute("target", "_blank");
    expect(chip.getAttribute("title")).toBeNull();

    await user.hover(chip);
    await waitFor(() => expect(preview()).not.toBeNull());
    const row = within(preview()!).getByRole("link", { name: new RegExp(source.title) });
    expect(row).toHaveAttribute("href", source.url);
    expect(row).toHaveAttribute("target", "_blank");
    expect(row).toHaveTextContent("example.com");
    expect(row).toHaveTextContent(source.snippet);
  });

  it("lets every source of a grouped chip be opened from its preview", async () => {
    const user = userEvent.setup();
    const other = {
      ...source,
      index: 2,
      url: "https://docs.example.org/page",
      title: "Second source",
      snippet: "Not shown for a secondary source.",
    };
    const handbook = {
      kind: "document" as const,
      index: 3,
      collectionId: "k1",
      documentId: "d1",
      versionId: "v1",
      startOffset: 0,
      endOffset: 120,
      title: "Internal handbook",
      snippet: "",
      read: true,
      page: 4,
      headingPath: "Travel",
    };
    render(
      <DetailPanelProvider>
        <CitationChip source={source} more={[other, handbook]} />
      </DetailPanelProvider>,
    );
    const chip = screen.getByRole("link", { name: `Sources: ${source.title} and 2 more` });
    expect(chip).toHaveTextContent("+2");

    await user.hover(chip);
    await waitFor(() => expect(preview()).not.toBeNull());
    const card = within(preview()!);
    expect(card.getByRole("link", { name: /Second source/ })).toHaveAttribute(
      "href",
      "https://docs.example.org/page",
    );
    expect(card.queryByText(other.snippet)).toBeNull();
    // A document has no page to link to; its row opens the reader like its chip.
    expect(card.getByRole("button", { name: /Internal handbook/ })).toBeVisible();
  });

  it("opens on keyboard focus and closes on Escape with a hostname-only source", async () => {
    const user = userEvent.setup();
    render(<CitationChip source={{ ...source, title: "", snippet: "" }} />);
    await user.tab();
    const chip = screen.getByRole("link", { name: "Source: example.com" });
    expect(chip).toHaveFocus();
    await waitFor(() => expect(preview()).not.toBeNull());
    expect(within(preview()!).getAllByText("example.com")).toHaveLength(2);

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(document.querySelector('[data-slot="hover-card-content"][data-open]')).toBeNull(),
    );
    expect(chip).toHaveFocus();
  });
});
