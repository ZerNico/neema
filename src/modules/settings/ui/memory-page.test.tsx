import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { MemoryPage } from "./memory-page.tsx";
import {
  clearMemories,
  createMemory,
  deleteMemory,
  getMemorySettings,
  listMemories,
  updateMemory,
  updateMemorySettings,
} from "~/modules/memory/server/functions.ts";
import type { Memory } from "~/modules/memory/schema.ts";
import { ConfirmProvider } from "~/ui/confirm.tsx";

vi.mock("~/modules/memory/server/functions.ts", () => ({
  clearMemories: vi.fn(),
  createMemory: vi.fn(),
  deleteMemory: vi.fn(),
  getMemorySettings: vi.fn(),
  listMemories: vi.fn(),
  updateMemory: vi.fn(),
  updateMemorySettings: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn() },
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, ...rest }: Record<string, unknown> & { children?: unknown }) => (
    <a
      href={String(to).replace(
        "$conversationId",
        String((params as { conversationId?: string })?.conversationId),
      )}
      {...(rest as object)}
    >
      {children as never}
    </a>
  ),
}));

const settingsMock = vi.mocked(getMemorySettings);
const listMock = vi.mocked(listMemories);
const createMock = vi.mocked(createMemory);
const updateMock = vi.mocked(updateMemory);
const deleteMock = vi.mocked(deleteMemory);
const clearMock = vi.mocked(clearMemories);
const updateSettingsMock = vi.mocked(updateMemorySettings);

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

const memory = (overrides: Partial<Memory> = {}): Memory => ({
  id: "memory-1",
  content: "Prefers concise answers",
  origin: "model",
  editedAt: null,
  sourceConversationId: "conversation-1",
  sourceConversationTitle: "Planning notes",
  sourceMessageId: "message-1",
  sourceMessageEdited: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  ...overrides,
});

const renderPage = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <MemoryPage />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
  return client;
};

beforeEach(() => {
  vi.clearAllMocks();
  settingsMock.mockResolvedValue({
    referenceEnabled: true,
    autoSaveEnabled: true,
    globalEnabled: true,
    effectiveReferenceEnabled: true,
    effectiveAutoSaveEnabled: true,
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as never);
  listMock.mockResolvedValue([] as never);
  updateSettingsMock.mockImplementation(
    async ({ data }) =>
      ({
        referenceEnabled: data.referenceEnabled ?? true,
        autoSaveEnabled: data.autoSaveEnabled ?? true,
        globalEnabled: true,
        effectiveReferenceEnabled: data.referenceEnabled ?? true,
        effectiveAutoSaveEnabled: data.autoSaveEnabled ?? true,
        updatedAt: "2026-01-02T00:00:00.000Z",
      }) as never,
  );
  createMock.mockResolvedValue({
    outcome: "created",
    memory: memory({ origin: "manual" }),
  } as never);
  updateMock.mockResolvedValue({ outcome: "updated", memory: memory() } as never);
  deleteMock.mockResolvedValue({ outcome: "deleted" } as never);
  clearMock.mockResolvedValue(1 as never);
});

describe("MemoryPage", () => {
  it("shows independent memory controls and an empty state", async () => {
    renderPage();

    expect(await screen.findByText("Nothing saved yet")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Reference saved memories" })).toBeChecked();
    expect(
      screen.getByRole("switch", { name: "Automatically save useful memories" }),
    ).toBeChecked();
    expect(screen.getByText("0 of 50")).toBeInTheDocument();
  });

  it("keeps raw preferences visible while global memory is paused", async () => {
    settingsMock.mockResolvedValue({
      referenceEnabled: true,
      autoSaveEnabled: true,
      globalEnabled: false,
      effectiveReferenceEnabled: false,
      effectiveAutoSaveEnabled: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    renderPage();

    expect(await screen.findByText("Memory is paused by an administrator")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Reference saved memories" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Reference saved memories" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(
      screen.getByRole("switch", { name: "Automatically save useful memories" }),
    ).toBeChecked();
    expect(
      screen.getByRole("switch", { name: "Automatically save useful memories" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(screen.getAllByRole("button", { name: "Add memory" })[0]).toBeEnabled();
  });

  it("updates only the changed setting", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole("switch", { name: "Automatically save useful memories" }),
    );

    await waitFor(() =>
      expect(updateSettingsMock).toHaveBeenCalledWith({
        data: { autoSaveEnabled: false },
      }),
    );
  });

  it("adds a memory through the multiline form", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Add memory" }));
    await user.type(screen.getByLabelText("Memory"), "I prefer concise examples");
    await user.click(screen.getByRole("button", { name: "Add memory" }));

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({ data: { content: "I prefer concise examples" } }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("renders provenance and lets the user clear all memories", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([
      memory(),
      memory({
        id: "memory-2",
        content: "Uses TypeScript",
        editedAt: "2026-01-03T00:00:00.000Z",
        sourceMessageEdited: true,
      }),
      memory({
        id: "memory-3",
        content: "Likes dark mode",
        sourceConversationId: null,
        sourceConversationTitle: null,
        sourceMessageId: null,
      }),
    ] as never);
    renderPage();

    expect(await screen.findByRole("link", { name: "Planning notes" })).toHaveAttribute(
      "href",
      "/chat/conversation-1",
    );
    expect(screen.getByText("Source message edited")).toBeInTheDocument();
    expect(screen.getByText("Source chat deleted")).toBeInTheDocument();
    expect(screen.getByText("Edited by you")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear all" }));
    await user.click(await screen.findByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(clearMock).toHaveBeenCalledTimes(1));
  });

  it("edits and deletes an existing memory", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([memory()] as never);
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Edit memory" }));
    const input = screen.getByLabelText("Memory");
    await user.clear(input);
    await user.type(input, "Prefer detailed examples");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith({
        data: { memoryId: "memory-1", content: "Prefer detailed examples" },
      }),
    );

    await user.click(await screen.findByRole("button", { name: "Delete memory" }));
    await user.click(await screen.findByRole("button", { name: "Delete memory" }));
    await waitFor(() =>
      expect(deleteMock).toHaveBeenCalledWith({ data: { memoryId: "memory-1" } }),
    );
  });

  it("keeps the memory dialog open and labelled while saving", async () => {
    const user = userEvent.setup();
    const pending = deferred<Awaited<ReturnType<typeof createMemory>>>();
    createMock.mockReturnValue(pending.promise);
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Add memory" }));
    await user.type(screen.getByLabelText("Memory"), "Remember this preference");
    await user.click(screen.getByRole("button", { name: "Add memory" }));

    const submit = screen.getByRole("button", { name: "Add memory" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(submit).toHaveTextContent("Add memory");
    expect(submit).toHaveAttribute("aria-busy", "true");
    expect(cancel).toBeDisabled();

    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    pending.resolve({ outcome: "created", memory: memory({ origin: "manual" }) } as never);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps failed writes open and explains rejected sensitive content", async () => {
    const user = userEvent.setup();
    createMock.mockResolvedValue({ outcome: "rejected", reason: "sensitive" } as never);
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Add memory" }));
    await user.type(screen.getByLabelText("Memory"), "password is secret123");
    await user.click(screen.getByRole("button", { name: "Add memory" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "That looks like a secret or credential and cannot be stored.",
      ),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
