import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { KnowledgeToolActivity } from "../client/use-message-stream.ts";
import { KnowledgeActivityBlock } from "./knowledge-activity-block.tsx";
import { AppMotionProvider } from "~/ui/motion.tsx";

vi.stubGlobal(
  "matchMedia",
  vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
);

const activity = (overrides: Partial<KnowledgeToolActivity>): KnowledgeToolActivity => ({
  family: "knowledge",
  callId: Math.random().toString(36).slice(2),
  name: "search_knowledge",
  status: "complete",
  turnIndex: 0,
  callIndex: 0,
  ...overrides,
});
const summary = (over: Partial<NonNullable<KnowledgeToolActivity["summary"]>> = {}) => ({
  targets: [],
  documentsListed: 0,
  passagesReturned: 0,
  remainingOps: 60,
  coverage: "",
  ...over,
});
const show = (activities: KnowledgeToolActivity[]) =>
  render(
    <AppMotionProvider>
      <KnowledgeActivityBlock activities={activities} />
    </AppMotionProvider>,
  );

describe("knowledge activity block", () => {
  it("collapses a run of calls into one row and lists the queries on demand", () => {
    show([
      activity({
        summary: summary({
          targets: ["BIÖG Richtlinien", "BIÖG"],
          passagesReturned: 5,
          mode: "lexical",
        }),
      }),
      activity({ summary: summary({ targets: ["Barrierefreiheit"], passagesReturned: 6 }) }),
      activity({
        name: "read_knowledge_document",
        summary: summary({ targets: ["v1"], passagesReturned: 2 }),
      }),
    ]);
    const trigger = screen.getByRole("button", { name: /Searched documents · 11 excerpts/ });
    // Collapsed by default once nothing is running: the queries are not on the row.
    expect(screen.queryByText(/BIÖG Richtlinien/)).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByText("“BIÖG Richtlinien”, “BIÖG”, “Barrierefreiheit”")).toBeInTheDocument();
    expect(screen.getByText(/keyword search/)).toBeInTheDocument();
    expect(screen.getByText("Read 2 excerpts in full")).toBeInTheDocument();
    // Opaque version ids never appear.
    expect(screen.queryByText(/v1/)).toBeNull();
  });

  it("shows the live step while running and names the queries as soon as they are known", () => {
    show([activity({ status: "running", summary: summary({ targets: ["one"] }) })]);
    expect(screen.getByText("Searching documents…")).toBeInTheDocument();
    // Open while running: what it is searching for is visible immediately.
    expect(screen.getByText("“one”")).toBeInTheDocument();
  });

  it("counts a listing without pretending it read anything", () => {
    show([
      activity({ name: "list_knowledge_documents", summary: summary({ documentsListed: 8 }) }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: /Listed documents/ }));
    expect(screen.getByText("Listed 8 documents")).toBeInTheDocument();
  });
});
