import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./composer.tsx";
import { ChatInput } from "./chat-input.tsx";
import type { AttachmentUploads } from "~/modules/attachments/client/use-attachment-uploads.ts";

vi.mock("../server/functions.ts", () => ({
  listChatModels: vi.fn(),
  listConversations: vi.fn(),
  getConversationWithMessages: vi.fn(),
}));
vi.mock("~/modules/tools/server/functions.ts", () => ({
  getWebSearchAvailability: vi.fn(),
  getResearchAvailability: vi.fn(),
}));
vi.mock("~/modules/attachments/server/functions.ts", () => ({
  getDocumentParsingAvailability: vi.fn(),
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
}));

const model = {
  id: "m1",
  providerId: "p1",
  providerName: "Provider",
  modelKey: "model",
  displayName: "Model",
  type: "chat",
  enabled: true,
  contextLength: 128_000,
  capabilities: { tools: true, reasoning: false, files: false, vision: false },
};
function client(available = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(["chat-models"], [model]);
  queryClient.setQueryData(["tools", "web-search", "availability"], {
    configured: true,
    enabled: true,
  });
  queryClient.setQueryData(["tools", "research", "availability"], {
    configured: available,
    enabled: available,
  });
  queryClient.setQueryData(["tools", "document-parsing", "availability"], {
    configured: false,
    enabled: false,
  });
  return queryClient;
}
function Harness({ onSend }: { onSend: React.ComponentProps<typeof Composer>["onSend"] }) {
  const [search, setSearch] = useState(false);
  return (
    <Composer
      onSend={onSend}
      disabled={false}
      modelId="m1"
      onModelChange={() => {}}
      searchEnabled={search}
      onSearchEnabledChange={setSearch}
    />
  );
}
async function enableResearch() {
  fireEvent.click(screen.getByRole("button", { name: "Add files or tools" }));
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Deep research" }));
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
}

describe("research composer", () => {
  it("restores the ordinary search preference when research is switched off", async () => {
    render(
      <QueryClientProvider client={client()}>
        <Harness onSend={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(
      screen.getByRole("button", { name: "Search the web" }).getAttribute("aria-pressed"),
    ).toBe("false");
    await enableResearch();
    expect(screen.queryByRole("button", { name: "Search the web" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Deep research" }));
    expect(
      screen.getByRole("button", { name: "Search the web" }).getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("retains a failed research draft, resets after success, and sends the next message normally", async () => {
    const onSend = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    render(
      <QueryClientProvider client={client()}>
        <Harness onSend={onSend} />
      </QueryClientProvider>,
    );
    await enableResearch();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Investigate this" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Investigate this", [], "research"));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Investigate this");
    expect(screen.getByRole("button", { name: "Deep research" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(""),
    );
    expect(screen.queryByRole("button", { name: "Deep research" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Thanks" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSend).toHaveBeenLastCalledWith("Thanks", []));
  });

  it("explains disabled research and blocks an already-selected request if availability changes", async () => {
    const cache = client();
    const onSend = vi.fn();
    render(
      <QueryClientProvider client={cache}>
        <Harness onSend={onSend} />
      </QueryClientProvider>,
    );
    await enableResearch();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Investigate this" } });
    await act(async () => {
      cache.setQueryData(["tools", "research", "availability"], {
        configured: true,
        enabled: false,
      });
    });
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    expect(screen.getByRole("status").textContent).toContain("page reading");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Deep research" }));
    fireEvent.click(screen.getByRole("button", { name: "Add files or tools" }));
    expect(
      (await screen.findByRole("menuitemcheckbox", { name: "Deep research" })).getAttribute(
        "aria-disabled",
      ),
    ).toBe("true");
  });

  it("keeps the submitted research mode fixed while attachments finish uploading", async () => {
    const onChange = vi.fn();
    const attachments = { items: [], isFull: false, queued: true } as unknown as AttachmentUploads;
    render(
      <QueryClientProvider client={client()}>
        <ChatInput
          value="Investigate this"
          onValueChange={() => {}}
          onSubmit={() => {}}
          disabled={false}
          modelId="m1"
          onModelChange={() => {}}
          searchEnabled={false}
          onSearchEnabledChange={() => {}}
          researchEnabled
          onResearchEnabledChange={onChange}
          attachments={attachments}
        />
      </QueryClientProvider>,
    );
    const chip = screen.getByRole("button", { name: "Deep research" });
    expect((chip as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole("button", { name: "Add files or tools" }));
    const checkbox = await screen.findByRole("menuitemcheckbox", { name: "Deep research" });
    expect(checkbox.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(checkbox);
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps research available with no uploads or a full attachment list (full=%s)",
    async (full) => {
      const onChange = vi.fn();
      const attachments = {
        items: [],
        isFull: true,
        queued: false,
      } as unknown as AttachmentUploads;
      render(
        <QueryClientProvider client={client()}>
          <ChatInput
            value=""
            onValueChange={() => {}}
            onSubmit={() => {}}
            disabled={false}
            modelId="m1"
            onModelChange={() => {}}
            searchEnabled={false}
            onSearchEnabledChange={() => {}}
            onResearchEnabledChange={onChange}
            {...(full ? { attachments } : {})}
          />
        </QueryClientProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Add files or tools" }));
      const checkbox = await screen.findByRole("menuitemcheckbox", { name: "Deep research" });
      expect(
        screen.getByRole("menuitem", { name: "Attach files" }).getAttribute("aria-disabled"),
      ).toBe("true");
      fireEvent.click(checkbox);
      expect(onChange).toHaveBeenCalledWith(true, expect.anything());
    },
  );
});
