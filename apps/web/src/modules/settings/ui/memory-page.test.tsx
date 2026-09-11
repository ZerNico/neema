import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    expect(screen.getByRole("switch", { name: "Use saved memories" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Save memories automatically" })).toBeChecked();
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
    expect(screen.getByRole("switch", { name: "Use saved memories" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Use saved memories" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("switch", { name: "Save memories automatically" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Save memories automatically" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getAllByRole("button", { name: "Add memory" })[0]).toBeEnabled();
  });

  it("updates only the changed setting", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("switch", { name: "Save memories automatically" }));

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

  it("blocks dismissal and repeat submission through both the write and refresh", async () => {
    const user = userEvent.setup();
    const pending = deferred<Awaited<ReturnType<typeof createMemory>>>();
    const refresh = deferred<Awaited<ReturnType<typeof listMemories>>>();
    createMock.mockReturnValueOnce(pending.promise);
    listMock.mockResolvedValue([memory()] as never);
    renderPage();
    await screen.findByText("Prefers concise answers");

    await user.click(screen.getByRole("button", { name: "Add memory" }));
    await user.type(screen.getByLabelText("Memory"), "Remember this preference");
    listMock.mockReturnValueOnce(refresh.promise);
    await user.click(screen.getByRole("button", { name: "Add memory" }));
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));

    const attemptDismissal = async () => {
      const submit = screen.getByRole("button", { name: "Add memory" });
      const cancel = screen.getByRole("button", { name: "Cancel" });
      expect(submit).toHaveTextContent("Add memory");
      expect(submit).toHaveAttribute("aria-busy", "true");
      expect(submit).toBeDisabled();
      expect(cancel).toBeDisabled();
      expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
      await user.click(cancel);
      await user.keyboard("{Escape}");
      await user.click(document.querySelector('[data-slot="dialog-overlay"]')!);
      fireEvent.submit(screen.getByLabelText("Memory").closest("form")!);
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByLabelText("Memory")).toHaveValue("Remember this preference");
      expect(createMock).toHaveBeenCalledTimes(1);
    };
    await attemptDismissal();
    await act(async () =>
      pending.resolve({ outcome: "created", memory: memory({ origin: "manual" }) } as never),
    );
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    await attemptDismissal();

    await act(async () => refresh.resolve([memory()] as never));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Add memory" }));
    expect(screen.getByLabelText("Memory")).toHaveValue("");
  });

  it.each(["Add memory", "Edit memory"])(
    "resets %s drafts only on opening, not on query updates",
    async (action) => {
      const user = userEvent.setup();
      listMock.mockResolvedValue([memory()] as never);
      const client = renderPage();
      await screen.findByText("Prefers concise answers");
      await user.click(screen.getByRole("button", { name: action }));
      await user.clear(screen.getByLabelText("Memory"));
      await user.type(screen.getByLabelText("Memory"), "Unsaved draft");

      act(() =>
        client.setQueryData(["memory", "list"], [memory({ content: "Updated elsewhere" })]),
      );
      expect(screen.getByLabelText("Memory")).toHaveValue("Unsaved draft");
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await screen.findByText("Updated elsewhere");
      await user.click(screen.getByRole("button", { name: action }));
      expect(screen.getByLabelText("Memory")).toHaveValue(
        action === "Add memory" ? "" : "Updated elsewhere",
      );
    },
  );

  it("uses the selected memory's defaults and ID when switching editors", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([
      memory(),
      memory({ id: "memory-2", content: "Uses TypeScript" }),
    ] as never);
    renderPage();
    await screen.findByText("Uses TypeScript");
    await user.click(screen.getAllByRole("button", { name: "Edit memory" })[0]!);
    await user.clear(screen.getByLabelText("Memory"));
    await user.type(screen.getByLabelText("Memory"), "Discard this draft");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getAllByRole("button", { name: "Edit memory" })[1]!);
    expect(screen.getByLabelText("Memory")).toHaveValue("Uses TypeScript");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith({
        data: { memoryId: "memory-2", content: "Uses TypeScript" },
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps the draft and re-enables submission after a thrown save error", async () => {
    const user = userEvent.setup();
    createMock.mockRejectedValueOnce(new Error("offline"));
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Add memory" }));
    await user.type(screen.getByLabelText("Memory"), "Keep this draft");
    await user.click(screen.getByRole("button", { name: "Add memory" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not save the memory."));
    expect(screen.getByLabelText("Memory")).toHaveValue("Keep this draft");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    const submit = screen.getByRole("button", { name: "Add memory" });
    expect(submit).toBeEnabled();
    expect(submit).not.toHaveAttribute("aria-busy", "true");
    await user.click(submit);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(createMock).toHaveBeenCalledTimes(2);
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
