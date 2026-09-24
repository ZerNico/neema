vi.mock("~/modules/skills/server/functions.ts", () => ({
  listSkills: vi.fn().mockResolvedValue([]),
}));
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./composer.tsx";
import { ALL_CAPABILITIES } from "~/modules/groups/policy.ts";
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
  queryClient.setQueryData(["capabilities"], ALL_CAPABILITIES);
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
const menu = () => screen.getByRole("button", { name: "Add files or tools" });
/** The offer lives only in the plus menu, so its state is read there. */
const researchItem = async () => {
  const open = screen.queryByRole("menuitemcheckbox", { name: "Deep research" });
  if (open) return open;
  fireEvent.click(menu());
  return screen.findByRole("menuitemcheckbox", { name: "Deep research" });
};
const searchPill = () => screen.queryByRole("button", { name: "Search the web" });
// A checkbox item leaves the menu open, so only open it when it is not already.
async function toggleResearch() {
  const open = screen.queryByRole("menuitemcheckbox", { name: "Deep research" });
  if (open) {
    fireEvent.click(open);
    return;
  }
  fireEvent.click(menu());
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Deep research" }));
}
const enableResearch = toggleResearch;
const disableResearch = toggleResearch;

describe("research composer", () => {
  it("withholds research when web search is not permitted, even if research is granted", async () => {
    const cache = client();
    cache.setQueryData(["capabilities"], { ...ALL_CAPABILITIES, webSearch: false });
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(
      <QueryClientProvider client={cache}>
        <Harness onSend={onSend} />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole("menuitemcheckbox", { name: "Deep research" })).toBeNull();
    expect(searchPill()).toBeNull();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Investigate this" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Investigate this", [], false, []));
  });

  it("does not submit a selected research mode after web search is revoked", async () => {
    const cache = client();
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(
      <QueryClientProvider client={cache}>
        <Harness onSend={onSend} />
      </QueryClientProvider>,
    );
    await enableResearch();
    await act(async () => {
      cache.setQueryData(["capabilities"], { ...ALL_CAPABILITIES, webSearch: false });
    });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Investigate this" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Investigate this", [], false, []));
  });

  it.each([false, true])(
    "preserves locked controls without an optional research handler (research=%s)",
    async (researchEnabled) => {
      render(
        <QueryClientProvider client={client()}>
          <ChatInput
            value="Draft"
            onValueChange={vi.fn()}
            onSubmit={vi.fn()}
            disabled={false}
            modelId="m1"
            onModelChange={vi.fn()}
            searchEnabled
            onSearchEnabledChange={vi.fn()}
            researchEnabled={researchEnabled}
          />
        </QueryClientProvider>,
      );
      // Search is an independent offer either way: research no longer takes
      // its place, so its own control never disappears.
      expect(searchPill()).toHaveAttribute("aria-pressed", "true");
      if (researchEnabled) {
        // No handler to change it with: the state is still readable, not editable.
        fireEvent.click(menu());
        const item = await screen.findByRole("menuitemcheckbox", { name: "Deep research" });
        expect(item).toHaveAttribute("aria-checked", "true");
        expect(item).toHaveAttribute("aria-disabled", "true");
      } else {
        // Nothing to offer and nothing on: the menu is only an attachment button.
        expect(screen.getByRole("button", { name: "Add attachment" })).toBeInTheDocument();
      }
    },
  );

  it("leaves the ordinary search preference alone when research is switched on", async () => {
    render(
      <QueryClientProvider client={client()}>
        <Harness onSend={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(searchPill()).toHaveAttribute("aria-pressed", "false");
    await enableResearch();
    expect(await researchItem()).toHaveAttribute("aria-checked", "true");
    expect(searchPill()).toHaveAttribute("aria-pressed", "false");
    await disableResearch();
    expect(searchPill()).toHaveAttribute("aria-pressed", "false");
  });

  it("preserves enabled search through keyboard research selection and back", async () => {
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client()}>
        <Harness onSend={vi.fn()} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Search the web" }));
    menu().focus();
    await user.keyboard("{Enter}");
    const research = await screen.findByRole("menuitemcheckbox", { name: "Deep research" });
    // Shown as a switch, but the item stays the one control screen readers meet.
    expect(
      research.querySelector('[data-slot="dropdown-menu-switch-item-indicator"]'),
    ).toHaveAttribute("aria-hidden", "true");
    research.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(research).toHaveAttribute("aria-checked", "true"));
    expect(research).toHaveAttribute("data-checked");
    expect(searchPill()).toHaveAttribute("aria-pressed", "true");
    research.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(research).toHaveAttribute("aria-checked", "false"));
    expect(searchPill()).toHaveAttribute("aria-pressed", "true");
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
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Investigate this", [], true, []));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Investigate this");
    expect(await researchItem()).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(""),
    );
    await waitFor(async () =>
      expect(await researchItem()).toHaveAttribute("aria-checked", "false"),
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Thanks" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSend).toHaveBeenLastCalledWith("Thanks", [], false, []));
  });

  it("explains disabled research and blocks an already-selected request if availability changes", async () => {
    const cache = client();
    const onSend = vi.fn().mockResolvedValue(undefined);
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
    await disableResearch();
    await waitFor(() =>
      expect(screen.getByRole("menuitemcheckbox", { name: "Deep research" })).toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    );
  });

  it.each(["queued", "locked"] as const)(
    "disables an already-open mode menu when %s",
    async (reason) => {
      const onChange = vi.fn();
      const cache = client();
      const view = (blocked: boolean) => (
        <QueryClientProvider client={cache}>
          <ChatInput
            value="Draft"
            onValueChange={vi.fn()}
            onSubmit={vi.fn()}
            disabled={false}
            controlsDisabled={reason === "locked" && blocked}
            modelId="m1"
            onModelChange={vi.fn()}
            searchEnabled={false}
            onSearchEnabledChange={vi.fn()}
            researchEnabled
            onResearchEnabledChange={onChange}
            attachments={Object.assign({} as AttachmentUploads, {
              items: [],
              isFull: false,
              queued: reason === "queued" && blocked,
            })}
          />
        </QueryClientProvider>
      );
      const { rerender } = render(view(false));
      fireEvent.click(screen.getByRole("button", { name: "Add files or tools" }));
      await screen.findByRole("menuitemcheckbox", { name: "Deep research" });
      rerender(view(true));
      for (const option of screen.getAllByRole("menuitemcheckbox")) {
        expect(option).toHaveAttribute("aria-disabled", "true");
        fireEvent.click(option);
      }
      expect(onChange).not.toHaveBeenCalled();
    },
  );

  it("keeps the submitted research offer fixed while attachments finish uploading", async () => {
    const onChange = vi.fn();
    const attachments = Object.assign({} as AttachmentUploads, {
      items: [],
      isFull: false,
      queued: true,
    });
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
    // The menu still opens, but every mode option is refused while uploading.
    fireEvent.click(menu());
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Deep research" }));
    expect(onChange).not.toHaveBeenCalled();
    for (const option of await screen.findAllByRole("menuitemcheckbox"))
      expect(option).toHaveAttribute("aria-disabled", "true");
  });

  it.each([false, true])(
    "keeps research available with no uploads or a full attachment list (full=%s)",
    async (full) => {
      const onChange = vi.fn();
      const attachments = Object.assign({} as AttachmentUploads, {
        items: [],
        isFull: true,
        queued: false,
      });
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
      fireEvent.click(menu());
      const checkbox = await screen.findByRole("menuitemcheckbox", { name: "Deep research" });
      fireEvent.click(checkbox);
      expect(onChange).toHaveBeenCalledWith(true);
    },
  );
});
