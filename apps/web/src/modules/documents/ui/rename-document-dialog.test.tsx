import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RenameDocumentDialog } from "./rename-document-dialog.tsx";

vi.mock("../server/document-functions.ts", () => ({ renameDocument: vi.fn() }));

const document = { id: "document-1", conversationId: "c", projectId: null };

describe("the rename dialog", () => {
  it("offers the title as it is when opened, after it changed elsewhere", async () => {
    const client = new QueryClient();
    const dialog = (title: string, open: boolean) => (
      <QueryClientProvider client={client}>
        <RenameDocumentDialog
          document={{ ...document, title }}
          open={open}
          onOpenChange={vi.fn()}
        />
      </QueryClientProvider>
    );
    const { rerender } = render(dialog("Plan", false));
    rerender(dialog("Launch plan", false));
    rerender(dialog("Launch plan", true));
    expect(await screen.findByRole("textbox", { name: "Title" })).toHaveValue("Launch plan");
  });
});
