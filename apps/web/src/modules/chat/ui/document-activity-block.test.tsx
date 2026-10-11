import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DocumentToolActivity } from "../client/use-message-stream.ts";
import { DocumentActivityBlock } from "./document-activity-block.tsx";
import { documentActivityLabel } from "./document-activity-label.ts";

const activity = (overrides: Partial<DocumentToolActivity> = {}): DocumentToolActivity => ({
  family: "document",
  name: "create_document",
  callId: "call-1",
  turnIndex: 0,
  callIndex: 0,
  status: "complete",
  result: {
    outcome: "created",
    documentId: "document-1",
    documentConversationId: "original-chat",
    title: "Trip plan",
    revision: 1,
  },
  ...overrides,
});

describe("document activity", () => {
  it("renders a branch-copied document reference as inert", () => {
    render(<DocumentActivityBlock activity={activity()} />);
    expect(screen.getByText("Trip plan")).toBeVisible();
    expect(screen.getByText("From another chat")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Open document/ })).not.toBeInTheDocument();
  });

  it("leaves an update row inert when its document has no controller here", () => {
    render(
      <DocumentActivityBlock
        activity={activity({
          name: "edit_document",
          result: {
            outcome: "updated",
            documentId: "document-1",
            documentConversationId: "original-chat",
            title: "Trip plan",
            revision: 2,
          },
        })}
      />,
    );
    expect(screen.getByText("Edited Trip plan")).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("keeps a failed patch compact instead of duplicating the creation card", () => {
    render(
      <DocumentActivityBlock
        activity={activity({
          status: "error",
          name: "edit_document",
          error: "Use a larger anchor.",
          result: {
            outcome: "ambiguous",
            documentId: "document-1",
            documentConversationId: "original-chat",
            title: "Trip plan",
            revision: 2,
          },
        })}
      />,
    );
    expect(screen.getByText("Couldn’t update the document")).toBeVisible();
    expect(screen.queryByText(/larger anchor/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Open document/ })).not.toBeInTheDocument();
  });

  it("keeps non-reference and running outcomes as compact activity labels", () => {
    expect(
      documentActivityLabel({
        family: "document",
        name: "edit_document",
        callId: "running",
        turnIndex: 0,
        callIndex: 0,
        status: "running",
      }),
    ).toBe("Editing the document");
    expect(
      documentActivityLabel(
        activity({
          status: "error",
          name: "edit_document",
          result: { outcome: "no_match", title: "Trip plan" },
        }),
      ),
    ).toBe("Couldn’t update the document");
  });
});
