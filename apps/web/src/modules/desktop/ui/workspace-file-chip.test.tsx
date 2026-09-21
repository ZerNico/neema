import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
import { LocalFileConversationProvider } from "./local-file-preview.tsx";
import { WorkspaceFileChip } from "./workspace-file-chip.tsx";

const bridge = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("../client/bridge.ts", () => ({ useDesktop: () => bridge.client }));

const fileInfo = vi.fn(() =>
  Effect.succeed({
    path: "/data/workspaces/chat/notes.md",
    bytes: 1024,
  }),
);
const folderStatus = vi.fn();

beforeEach(() => {
  fileInfo.mockClear();
  folderStatus.mockClear();
  bridge.client = { fileInfo, folderStatus };
});

const show = (client: QueryClient) =>
  render(
    <QueryClientProvider client={client}>
      <LocalFileConversationProvider
        conversationId="01990f4e-6650-7a33-a768-611e2e4bf4c7"
        workspaceRoot="/data/workspaces/chat"
      >
        <WorkspaceFileChip fileName="notes.md" />
      </LocalFileConversationProvider>
    </QueryClientProvider>,
  );

it("derives the workspace path without reading folder status and caches metadata across remounts", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const first = show(client);

  await screen.findByText("Workspace · 1 KB");
  expect(fileInfo).toHaveBeenCalledWith({
    conversationId: "01990f4e-6650-7a33-a768-611e2e4bf4c7",
    path: "/data/workspaces/chat/notes.md",
    callId: expect.any(String),
  });
  expect(fileInfo).toHaveBeenCalledTimes(1);
  expect(folderStatus).not.toHaveBeenCalled();

  first.unmount();
  show(client);

  await waitFor(() => expect(screen.getByText("Workspace · 1 KB")).toBeInTheDocument());
  expect(fileInfo).toHaveBeenCalledTimes(1);
  expect(folderStatus).not.toHaveBeenCalled();
  client.clear();
});

it("keeps the chip inert without a local desktop", () => {
  bridge.client = null;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  show(client);

  expect(screen.getByRole("button", { name: "Preview notes.md" })).toBeDisabled();
  expect(fileInfo).not.toHaveBeenCalled();
  expect(folderStatus).not.toHaveBeenCalled();
  client.clear();
});
