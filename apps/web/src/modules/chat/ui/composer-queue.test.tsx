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
  composerTagCount,
  composerText,
  focusComposer,
  setComposerText,
  typeInComposer,
} from "./composer-test-utils.ts";
import { tagMarkup } from "../tags.ts";

// A picked skill is a tag in the draft; the text carries its link.
const REVIEW = tagMarkup({ kind: "skill", id: "review", name: "review" });
const REWRITE = tagMarkup({ kind: "skill", id: "rewrite", name: "rewrite" });

vi.mock("../server/functions.ts", () => ({
  listChatModels: vi.fn(),
  listConversations: vi.fn(),
  getConversationWithMessages: vi.fn(),
}));
vi.mock("~/modules/skills/server/functions.ts", () => ({ listSkills: vi.fn() }));
vi.mock("~/modules/tools/server/functions.ts", () => ({
  getComposerAvailability: vi.fn(),
}));
vi.mock("~/modules/attachments/server/functions.ts", () => ({
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
  client.setQueryData(["tools", "availability"], (current: object | undefined) => ({
    ...current,
    search: { configured: true, enabled: true },
  }));
  client.setQueryData(["tools", "availability"], (current: object | undefined) => ({
    ...current,
    research: { configured: true, enabled: true },
  }));
  client.setQueryData(["tools", "availability"], (current: object | undefined) => ({
    ...current,
    documentParsing: {
      configured: false,
      enabled: false,
    },
  }));
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
  setComposerText(textbox, `${REVIEW} Original draft`);
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
  // Clearing the draft takes the review tag, and with it the skill.
  setComposerText(textbox, "");
  focusComposer(textbox);
  typeInComposer(textbox, "/rewrite");
  await screen.findByRole("listbox", { name: "Local skills" });
  fireEvent.keyDown(textbox, { key: "Enter" });
  expect(composerText(textbox)).toBe(`${REWRITE} `);
  setComposerText(textbox, `Updated draft ${REWRITE}`);
}

describe("upload-queued composer requests", () => {
  it.each(["accept", "reject"])(
    "holds removed fresh files during a normal send until %s",
    async (outcome) => {
      const pending = deferred<void>();
      const { upload, onSend, textbox } = setup(vi.fn().mockReturnValueOnce(pending.promise));
      await act(async () => upload.resolve(attachment));
      await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
      fireEvent.click(screen.getByRole("button", { name: "Remove notes.txt" }));
      expect(deleteAttachment).not.toHaveBeenCalled();
      setComposerText(textbox, "Later draft");
      await act(async () =>
        outcome === "accept" ? pending.resolve() : pending.reject(new Error("Refused")),
      );
      if (outcome === "reject")
        await waitFor(() =>
          expect(deleteAttachment).toHaveBeenCalledWith({ data: { attachmentId: attachment.id } }),
        );
      else expect(deleteAttachment).not.toHaveBeenCalled();
      expect(composerText(textbox)).toBe("Later draft");
    },
  );

  it("does not consume retyped equal text after a normal send", async () => {
    const pending = deferred<void>();
    const { upload, onSend, textbox } = setup(vi.fn().mockReturnValueOnce(pending.promise));
    await act(async () => upload.resolve(attachment));
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    const submitted = composerText(textbox);
    setComposerText(textbox, "Different next draft");
    setComposerText(textbox, submitted);
    await act(async () => pending.resolve());
    expect(composerText(textbox)).toBe(submitted);
  });
  it("sends the current text and replacement skill exactly once", async () => {
    const { upload, onSend, textbox } = setup();
    await replaceSkill(textbox);
    await act(async () => upload.resolve(attachment));
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledExactlyOnceWith(
        `Updated draft ${REWRITE}`,
        [attachment.id],
        false,
        ["rewrite"],
      ),
    );
    expect(composerText(textbox)).toBe("");
    expect(screen.queryByText("notes.txt")).not.toBeInTheDocument();
  });

  it("keeps the submitted skill selected in a later draft that still uses its tag", async () => {
    const pending = deferred<void>();
    const { upload, onSend, textbox } = setup(vi.fn().mockReturnValueOnce(pending.promise));
    await act(async () => upload.resolve(attachment));
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    setComposerText(textbox, `${REVIEW} Later B`);
    await act(async () => pending.resolve());
    expect(composerText(textbox)).toBe(`${REVIEW} Later B`);
    expect(composerTagCount(textbox)).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    await waitFor(() =>
      expect(onSend).toHaveBeenLastCalledWith(`${REVIEW} Later B`, [], false, ["review"]),
    );
  });

  it("does not send a removed skill when nothing replaces it", async () => {
    const { upload, onSend, textbox } = setup();
    // Deleting the tag from the text drops the skill.
    setComposerText(textbox, "Original draft");
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
      expect(onSend).toHaveBeenCalledExactlyOnceWith(
        `${REVIEW} Original draft`,
        [attachment.id],
        false,
        ["review"],
      ),
    );
    expect(currentSend).not.toHaveBeenCalled();
  });

  it("retains the current draft, skills and attachment when sending fails", async () => {
    const { upload, onSend, textbox } = setup(vi.fn().mockRejectedValue(new Error("offline")));
    await replaceSkill(textbox);
    await act(async () => upload.resolve(attachment));
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledExactlyOnceWith(
        `Updated draft ${REWRITE}`,
        [attachment.id],
        false,
        ["rewrite"],
      ),
    );
    expect(composerText(textbox)).toBe(`Updated draft ${REWRITE}`);
    expect(composerTagCount(textbox)).toBe(1);
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
    expect(composerText(textbox)).toBe(`Updated draft ${REWRITE}`);
    expect(composerTagCount(textbox)).toBe(1);
  });
});

const openEdit = async (content = "Summarise the attached notes") => {
  fireEvent.click(screen.getByRole("button", { name: `More actions: ${content}` }));
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

  function renderEditing(entry = queued, otherEntries: (typeof queued)[] = []) {
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
    client.setQueryData(["tools", "availability"], (current: object | undefined) => ({
      ...current,
      search: {
        configured: true,
        enabled: true,
      },
    }));
    client.setQueryData(["tools", "availability"], (current: object | undefined) => ({
      ...current,
      research: { configured: true, enabled: true },
    }));
    client.setQueryData(["tools", "availability"], (current: object | undefined) => ({
      ...current,
      documentParsing: {
        configured: false,
        enabled: false,
      },
    }));
    const queue = {
      entries: [entry, ...otherEntries],
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

  it.each(["different entry", "same entry"])(
    "preserves a newer queued edit session for the %s after stale acceptance",
    async (target) => {
      const first = {
        ...queued,
        content: "First queued message",
        attachments: [],
        input: { researchEnabled: false, skillIds: ["review"] },
      };
      const second = {
        ...queued,
        id: "entry-2",
        content: "Second queued message",
        attachments: [],
      };
      const reopened = target === "same entry" ? first : second;
      const { queue, onQueue, onSend, textbox } = renderEditing(first, [second]);
      const pending = deferred<void>();
      const replacement = deferred<void>();
      queue.onReplace.mockReturnValueOnce(pending.promise).mockReturnValueOnce(replacement.promise);
      await openEdit(first.content);
      setComposerText(textbox, "Accepted first edit");
      fireEvent.click(screen.getByRole("button", { name: "Save queued message" }));
      await waitFor(() => expect(queue.onReplace).toHaveBeenCalledOnce());
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
      fireEvent.keyDown(textbox, { key: "Escape" });
      expect(composerText(textbox)).toBe("");
      expect(queue.onEditEnd).toHaveBeenCalledOnce();
      await openEdit(reopened.content);
      expect(queue.onEditStart).toHaveBeenLastCalledWith(reopened);
      const reopenedText = composerText(textbox);
      expect(reopenedText).toContain(reopened.content);
      expect(screen.getByRole("button", { name: "Save queued message" })).toBeDisabled();
      await act(async () => pending.resolve());
      expect(composerText(textbox)).toBe(reopenedText);
      expect(queue.onEditEnd).toHaveBeenCalledOnce();
      expect(screen.getByRole("button", { name: "Save queued message" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Save queued message" }));
      await waitFor(() =>
        expect(queue.onReplace).toHaveBeenLastCalledWith(
          reopened.id,
          reopenedText.trim(),
          [],
          reopened.input.researchEnabled,
          reopened.input.skillIds,
        ),
      );
      expect(queue.onReplace).toHaveBeenCalledTimes(2);
      expect(onQueue).not.toHaveBeenCalled();
      expect(onSend).not.toHaveBeenCalled();
      await act(async () => replacement.resolve());
      expect(queue.onEditEnd).toHaveBeenCalledTimes(2);
    },
  );

  it("ends the unchanged queued edit session when its replacement accepts", async () => {
    const { queue, onQueue, textbox } = renderEditing();
    const pending = deferred<void>();
    queue.onReplace.mockReturnValueOnce(pending.promise);
    await openEdit();
    fireEvent.click(screen.getByRole("button", { name: "Save queued message" }));
    await waitFor(() => expect(queue.onReplace).toHaveBeenCalledOnce());
    expect(queue.onEditEnd).not.toHaveBeenCalled();
    await act(async () => pending.resolve());
    expect(composerText(textbox)).toBe("");
    expect(screen.queryByRole("button", { name: "Save queued message" })).toBeNull();
    expect(queue.onEditEnd).toHaveBeenCalledOnce();
    expect(onQueue).not.toHaveBeenCalled();
  });

  it.each(["accept", "reject"])(
    "retains removed fresh files through queued replacement %s",
    async (outcome) => {
      const { queue } = renderEditing();
      const pending = deferred<void>();
      queue.onReplace.mockReturnValueOnce(pending.promise);
      await openEdit();
      vi.mocked(uploadAttachment).mockResolvedValueOnce({
        ...attachment,
        id: "fresh",
        fileName: "fresh.txt",
      });
      fireEvent.change(document.querySelector('input[type="file"]')!, {
        target: { files: [new File(["fresh"], "fresh.txt", { type: "text/plain" })] },
      });
      await screen.findByRole("button", { name: "Remove fresh.txt" });
      fireEvent.click(screen.getByRole("button", { name: "Save queued message" }));
      await waitFor(() => expect(queue.onReplace).toHaveBeenCalledOnce());
      expect(queue.onReplace.mock.calls[0]![2]).toEqual([attachment.id, "fresh"]);
      fireEvent.click(screen.getByRole("button", { name: "Remove fresh.txt" }));
      expect(deleteAttachment).not.toHaveBeenCalled();
      await act(async () =>
        outcome === "accept" ? pending.resolve() : pending.reject(new Error("Refused")),
      );
      if (outcome === "reject")
        await waitFor(() =>
          expect(deleteAttachment).toHaveBeenCalledWith({ data: { attachmentId: "fresh" } }),
        );
      else expect(deleteAttachment).not.toHaveBeenCalled();
    },
  );

  it("preserves a newly retyped equal-valued draft after an earlier queue accepts", async () => {
    const { onQueue, textbox } = renderEditing();
    const pending = deferred<void>();
    onQueue.mockReturnValueOnce(pending.promise);
    setComposerText(textbox, "Continue");
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    await waitFor(() => expect(onQueue).toHaveBeenCalledOnce());
    setComposerText(textbox, "");
    setComposerText(textbox, "Different next draft");
    setComposerText(textbox, "Continue");
    await act(async () => pending.resolve());
    expect(composerText(textbox)).toBe("Continue");
    expect(onQueue).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    await waitFor(() => expect(onQueue).toHaveBeenCalledTimes(2));
    expect(onQueue).toHaveBeenLastCalledWith("Continue", [], false, []);
  });

  it("preserves the later draft when an earlier queue request succeeds", async () => {
    const { onQueue, textbox } = renderEditing();
    const pending = deferred<void>();
    onQueue.mockReturnValueOnce(pending.promise);
    setComposerText(textbox, "Submitted A");
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    await waitFor(() => expect(onQueue).toHaveBeenCalledOnce());
    setComposerText(textbox, "Later B");
    await act(async () => pending.resolve());
    expect(composerText(textbox)).toBe("Later B");
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    await waitFor(() => expect(onQueue).toHaveBeenLastCalledWith("Later B", [], false, []));
  });

  it("shares a synchronous latch between button and repeated Enter, then releases it on failure", async () => {
    const { onQueue, textbox } = renderEditing();
    const pending = deferred<void>();
    onQueue.mockReturnValueOnce(pending.promise);
    setComposerText(textbox, "Submitted A");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
      fireEvent.keyDown(textbox, { key: "Enter" });
      fireEvent.keyDown(textbox, { key: "Enter" });
    });
    await waitFor(() => expect(onQueue).toHaveBeenCalledOnce());
    await act(async () => pending.reject(new Error("Offline")));
    expect(composerText(textbox)).toBe("Submitted A");
    fireEvent.keyDown(textbox, { key: "Enter" });
    await waitFor(() => expect(onQueue).toHaveBeenCalledTimes(2));
  });

  it("preserves later text, skill selection and attachment while acknowledging a replacement", async () => {
    const { queue, textbox } = renderEditing();
    const pending = deferred<void>();
    queue.onReplace.mockReturnValueOnce(pending.promise);
    await openEdit();
    setComposerText(textbox, "Submitted A");
    fireEvent.click(screen.getByRole("button", { name: "Save queued message" }));
    await waitFor(() => expect(queue.onReplace).toHaveBeenCalledOnce());
    await replaceSkill(textbox);
    vi.mocked(uploadAttachment).mockResolvedValueOnce({
      ...attachment,
      id: "later-file",
      fileName: "later.txt",
    });
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [new File(["later"], "later.txt", { type: "text/plain" })] },
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove later.txt" })).toBeInTheDocument(),
    );
    await act(async () => pending.resolve());
    expect(composerText(textbox)).toBe(`Updated draft ${REWRITE}`);
    expect(composerTagCount(textbox)).toBe(1);
    expect(screen.getByRole("button", { name: "Remove later.txt" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove notes.txt" })).toBeNull();
    expect(queue.onEditEnd).toHaveBeenCalledOnce();
    expect(deleteAttachment).not.toHaveBeenCalled();
  });

  it("preserves a submitted reference still used by a later replacement draft", async () => {
    const { queue, onQueue, textbox } = renderEditing({
      ...queued,
      content: "Submitted [plan](/agents/plan)",
    });
    const pending = deferred<void>();
    queue.onReplace.mockReturnValueOnce(pending.promise);
    fireEvent.click(
      screen.getByRole("button", { name: "More actions: Submitted [plan](/agents/plan)" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    setComposerText(textbox, "Submitted plan");
    fireEvent.click(screen.getByRole("button", { name: "Save queued message" }));
    await waitFor(() => expect(queue.onReplace).toHaveBeenCalledOnce());
    setComposerText(textbox, "Later plan");
    await act(async () => pending.resolve());
    expect(composerText(textbox)).toBe("Later plan");
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    await waitFor(() =>
      expect(onQueue).toHaveBeenLastCalledWith("Later [plan](/agents/plan)", [], true, []),
    );
  });

  it("reopens the entry with its files and settings, and saves it in place", async () => {
    const { queue, onSend, onQueue, textbox } = renderEditing();
    await openEdit();

    // Queued with the skill but not its tag: the tag is put back at the caret.
    expect(composerText(textbox)).toBe(`Summarise the attached notes ${REWRITE} `);
    // Its file is back in the composer as a chip, beside the row's own in the strip.
    expect(screen.getByRole("button", { name: "Remove notes.txt" })).toBeInTheDocument();
    expect(queue.onEditStart).toHaveBeenCalledExactlyOnceWith(queued);

    setComposerText(textbox, `Summarise it in three bullets ${REWRITE}`);
    // A response is running, and saving is still the primary action, not Stop.
    fireEvent.click(screen.getByRole("button", { name: "Save queued message" }));

    await waitFor(() =>
      expect(queue.onReplace).toHaveBeenCalledExactlyOnceWith(
        "entry-1",
        `Summarise it in three bullets ${REWRITE}`,
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
