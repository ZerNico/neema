import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { removeChatFile } from "~/modules/limits/server/functions.ts";
import { StoragePage } from "./storage-page.tsx";

vi.mock("~/modules/limits/client/queries.ts", () => ({
  myStorageQuery: { queryKey: ["test-storage"], queryFn: () => null },
  myLibraryQuery: { queryKey: ["test-library"], queryFn: () => null },
}));
vi.mock("~/modules/limits/server/functions.ts", () => ({
  removeChatFile: vi.fn(),
}));
vi.mock("~/modules/attachments/server/functions.ts", () => ({ deleteAttachment: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: { children?: React.ReactNode }) => (
    <a href="/somewhere" {...props}>
      {children}
    </a>
  ),
}));

const MB = 1024 ** 2;

const renderPage = () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["test-storage"], { used: 30 * MB, quota: 100 * MB });
  client.setQueryData(["test-library"], {
    files: [
      {
        blobId: "a",
        size: 20 * MB,
        mediaType: "application/pdf",
        createdAt: "2026-10-01T00:00:00.000Z",
        places: [
          {
            kind: "chat",
            attachmentId: "att-a",
            name: "report.pdf",
            conversationId: "c1",
            title: "Quarterly",
            deleted: false,
            removable: true,
          },
        ],
      },
      {
        blobId: "b",
        size: 10 * MB,
        mediaType: "application/vnd.ms-excel",
        createdAt: "2026-10-02T00:00:00.000Z",
        places: [
          {
            kind: "project",
            name: "plan.xlsx",
            projectId: "p1",
            projectName: "Launch",
            versions: 3,
          },
        ],
      },
    ],
  });
  render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <StoragePage />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
};

describe("Settings › Storage", () => {
  it("shows what is used and where each file is", () => {
    renderPage();
    expect(screen.getByRole("progressbar", { name: "30 MB of 100 MB used" })).toBeVisible();
    expect(screen.getByText("20 MB · In “Quarterly”")).toBeVisible();
    expect(screen.getByText("10 MB · Project “Launch” · 3 versions")).toBeVisible();
  });

  it("deletes a chat file here and sends a project's to where it is managed", async () => {
    vi.mocked(removeChatFile).mockResolvedValue(undefined as never);
    const user = renderPage();
    const project = screen.getByText("plan.xlsx").closest("div")!.parentElement!;
    expect(within(project).getByRole("link", { name: "Open" })).toBeVisible();
    expect(within(project).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    const chat = screen.getByText("report.pdf").closest("div")!.parentElement!;
    await user.click(within(chat).getByRole("button", { name: "Delete" }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(removeChatFile).toHaveBeenCalledWith({ data: { attachmentId: "att-a" } }),
    );
  });

  it("filters by place and finds files by name", async () => {
    const user = renderPage();
    await user.type(screen.getByLabelText("Search files"), "plan");
    expect(screen.queryByText("report.pdf")).not.toBeInTheDocument();
    expect(screen.getByText("plan.xlsx")).toBeVisible();
  });
});
