import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { Composer } from "./composer.tsx";
import { ALL_CAPABILITIES } from "~/modules/groups/policy.ts";
import type { Attachment } from "~/modules/attachments/schema.ts";
import { deleteAttachment, uploadAttachment } from "~/modules/attachments/server/functions.ts";
import type { SkillSummary } from "~/modules/skills/schema.ts";
import {
  composerText,
  focusComposer,
  setComposerText,
  typeInComposer,
} from "./composer-test-utils.ts";

vi.mock("../server/functions.ts", () => ({
  listChatModels: vi.fn(),
  listConversations: vi.fn(),
  getConversationWithMessages: vi.fn(),
}));
vi.mock("~/modules/skills/server/functions.ts", () => ({ listSkills: vi.fn() }));
vi.mock("~/modules/tools/server/functions.ts", () => ({
  getWebSearchAvailability: vi.fn(),
  getResearchAvailability: vi.fn(),
}));
vi.mock("~/modules/attachments/server/functions.ts", () => ({
  getDocumentParsingAvailability: vi.fn(),
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
}));

const skills: SkillSummary[] = ["review", "rewrite"].map((name) => ({
  id: name,
  name,
  description: `${name} carefully`,
  manualOnly: false,
  audience: "private",
  canEdit: true,
  ownerName: null,
  revision: 1,
  updatedAt: "2026-09-09",
}));
const attachment: Attachment = {
  id: "attachment-1",
  fileName: "notes.txt",
  size: 5,
  mediaType: "text/plain",
  kind: "text",
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  URL.createObjectURL = vi.fn(() => "blob:test");
  URL.revokeObjectURL = vi.fn();
});

function setup(onSend = vi.fn().mockResolvedValue(undefined)) {
  const upload = deferred<Attachment>();
  vi.mocked(uploadAttachment).mockReturnValue(upload.promise);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["capabilities"], ALL_CAPABILITIES);
  client.setQueryData(
    ["chat-models"],
    [
      {
        id: "model-1",
        providerId: "provider-1",
        providerName: "Provider",
        modelKey: "model",
        displayName: "Model",
        type: "chat",
        enabled: true,
        contextLength: 128_000,
        capabilities: { tools: true, reasoning: false, files: false, vision: false },
      },
    ],
  );
  client.setQueryData(["skills"], skills);
  client.setQueryData(["tools", "web-search", "availability"], { configured: true, enabled: true });
  client.setQueryData(["tools", "research", "availability"], { configured: true, enabled: true });
  client.setQueryData(["tools", "document-parsing", "availability"], {
    configured: false,
    enabled: false,
  });
  const view = (send: ComponentProps<typeof Composer>["onSend"]) => (
    <QueryClientProvider client={client}>
      <Composer
        initialSkillId="review"
        onSend={send}
        disabled={false}
        modelId="model-1"
        onModelChange={vi.fn()}
        searchEnabled={false}
        onSearchEnabledChange={vi.fn()}
      />
    </QueryClientProvider>
  );
  const rendered = render(view(onSend));
  const textbox = screen.getByRole("textbox");
  setComposerText(textbox, "Original draft");
  fireEvent.change(rendered.container.querySelector('input[type="file"]')!, {
    target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
  });
  fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
  expect(screen.getByRole("button", { name: "Sending after uploads finish" })).toBeInTheDocument();
  expect(onSend).not.toHaveBeenCalled();
  return {
    upload,
    onSend,
    textbox,
    rerender: (send: ComponentProps<typeof Composer>["onSend"]) => rendered.rerender(view(send)),
  };
}

async function replaceSkill(textbox: HTMLElement) {
  fireEvent.click(screen.getByRole("button", { name: "Remove review" }));
  setComposerText(textbox, "");
  focusComposer(textbox);
  typeInComposer(textbox, "/rewrite");
  await screen.findByRole("listbox", { name: "Local skills" });
  fireEvent.keyDown(textbox, { key: "Enter" });
  expect(screen.getByRole("button", { name: "Remove rewrite" })).toBeInTheDocument();
  setComposerText(textbox, "Updated draft");
}

describe("upload-queued composer requests", () => {
  it("sends the current text and replacement skill exactly once", async () => {
    const { upload, onSend, textbox } = setup();
    await replaceSkill(textbox);
    await act(async () => upload.resolve(attachment));
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledExactlyOnceWith("Updated draft", [attachment.id], false, [
        "rewrite",
      ]),
    );
    expect(composerText(textbox)).toBe("");
    expect(screen.queryByRole("button", { name: "Remove rewrite" })).not.toBeInTheDocument();
    expect(screen.queryByText("notes.txt")).not.toBeInTheDocument();
  });

  it("does not send a removed skill when nothing replaces it", async () => {
    const { upload, onSend } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Remove review" }));
    await act(async () => upload.resolve(attachment));
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledExactlyOnceWith("Original draft", [attachment.id], false, []),
    );
  });

  it("uses the send callback from the click, not a later parent rerender", async () => {
    const { upload, onSend, rerender } = setup();
    const currentSend = vi.fn().mockResolvedValue(undefined);
    rerender(currentSend);
    await act(async () => upload.resolve(attachment));
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledExactlyOnceWith("Original draft", [attachment.id], false, [
        "review",
      ]),
    );
    expect(currentSend).not.toHaveBeenCalled();
  });

  it("retains the current draft, skills and attachment when sending fails", async () => {
    const { upload, onSend, textbox } = setup(vi.fn().mockRejectedValue(new Error("offline")));
    await replaceSkill(textbox);
    await act(async () => upload.resolve(attachment));
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledExactlyOnceWith("Updated draft", [attachment.id], false, [
        "rewrite",
      ]),
    );
    expect(composerText(textbox)).toBe("Updated draft");
    expect(screen.getByRole("button", { name: "Remove rewrite" })).toBeInTheDocument();
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
  });

  it("cancels a failed upload without losing the current draft or skills", async () => {
    const { upload, onSend, textbox } = setup();
    await replaceSkill(textbox);
    await act(async () => upload.reject(new Error("offline")));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Sending after uploads finish" }),
      ).not.toBeInTheDocument(),
    );
    expect(onSend).not.toHaveBeenCalled();
    expect(composerText(textbox)).toBe("Updated draft");
    expect(screen.getByRole("button", { name: "Remove rewrite" })).toBeInTheDocument();
  });
});

const openEdit = async () => {
  fireEvent.click(
    screen.getByRole("button", { name: "More actions: Summarise the attached notes" }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
};

describe("editing a queued message", () => {
  const queued = {
    id: "entry-1",
    content: "Summarise the attached notes",
    lastError: null,
    attachments: [attachment],
    input: { researchEnabled: true, skillIds: ["rewrite"] },
  };

  function renderEditing() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(["capabilities"], ALL_CAPABILITIES);
    client.setQueryData(
      ["chat-models"],
      [
        {
          id: "model-1",
          providerId: "provider-1",
          providerName: "Provider",
          modelKey: "model",
          displayName: "Model",
          type: "chat",
          enabled: true,
          contextLength: 128_000,
          capabilities: { tools: true, reasoning: false, files: false, vision: false },
        },
      ],
    );
    client.setQueryData(["skills"], skills);
    client.setQueryData(["tools", "web-search", "availability"], {
      configured: true,
      enabled: true,
    });
    client.setQueryData(["tools", "research", "availability"], { configured: true, enabled: true });
    client.setQueryData(["tools", "document-parsing", "availability"], {
      configured: false,
      enabled: false,
    });
    const queue = {
      entries: [queued],
      steeringIds: new Set<string>(),
      paused: null,
      onSteer: vi.fn(),
      onRemove: vi.fn(),
      onDispatch: vi.fn(),
      onSendNow: vi.fn(),
      sendNowBlocked: null,
      onReplace: vi.fn().mockResolvedValue(undefined),
      onEditStart: vi.fn(),
      onEditEnd: vi.fn(),
    };
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onQueue = vi.fn().mockResolvedValue(undefined);
    render(
      <QueryClientProvider client={client}>
        <Composer
          onSend={onSend}
          onQueue={onQueue}
          onStop={vi.fn()}
          queue={queue}
          disabled={false}
          modelId="model-1"
          onModelChange={vi.fn()}
          searchEnabled={false}
          onSearchEnabledChange={vi.fn()}
        />
      </QueryClientProvider>,
    );
    return { queue, onSend, onQueue, textbox: screen.getByRole("textbox") };
  }

  it("reopens the entry with its files and settings, and saves it in place", async () => {
    const { queue, onSend, onQueue, textbox } = renderEditing();
    await openEdit();

    expect(composerText(textbox)).toBe("Summarise the attached notes");
    // Its file is back in the composer as a chip, beside the row's own in the strip.
    expect(screen.getByRole("button", { name: "Remove notes.txt" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove rewrite" })).toBeInTheDocument();
    expect(queue.onEditStart).toHaveBeenCalledExactlyOnceWith(queued);

    setComposerText(textbox, "Summarise it in three bullets");
    // A response is running, and saving is still the primary action, not Stop.
    fireEvent.click(screen.getByRole("button", { name: "Save queued message" }));

    await waitFor(() =>
      expect(queue.onReplace).toHaveBeenCalledExactlyOnceWith(
        "entry-1",
        "Summarise it in three bullets",
        [attachment.id],
        true,
        ["rewrite"],
      ),
    );
    expect(onQueue).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(composerText(textbox)).toBe(""));
    expect(queue.onEditEnd).toHaveBeenCalledOnce();
    // The queued message still owns its file; clearing the chip deletes nothing.
    expect(deleteAttachment).not.toHaveBeenCalled();
  });

  it("cancels without touching the queued message's files", async () => {
    const { queue, textbox } = renderEditing();
    await openEdit();
    fireEvent.click(screen.getByRole("button", { name: "Remove notes.txt" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(composerText(textbox)).toBe("");
    expect(queue.onReplace).not.toHaveBeenCalled();
    expect(queue.onEditEnd).toHaveBeenCalledOnce();
    expect(deleteAttachment).not.toHaveBeenCalled();
  });

  it("will not discard a draft to open a queued message", async () => {
    const { queue, textbox } = renderEditing();
    setComposerText(textbox, "Half-written thought");
    fireEvent.click(
      screen.getByRole("button", { name: "More actions: Summarise the attached notes" }),
    );
    expect(await screen.findByRole("menuitem", { name: "Edit" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(queue.onEditStart).not.toHaveBeenCalled();
    expect(composerText(textbox)).toBe("Half-written thought");
  });
});
