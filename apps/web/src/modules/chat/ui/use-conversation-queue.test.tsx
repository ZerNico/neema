import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchQueuedMessage,
  queueMessage,
  sendQueuedNow,
  steerQueuedMessage,
} from "../server/functions.ts";
import { toast } from "sonner";
import { AlreadyTold } from "~/ui/error-toast.ts";
import { useConversationQueue, type QueueRow, type QueueState } from "./use-conversation-queue.ts";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

vi.mock("../server/functions.ts", () => ({
  queueMessage: vi.fn(),
  replaceQueuedMessage: vi.fn(),
  removeQueuedMessage: vi.fn(),
  steerQueuedMessage: vi.fn(),
  sendQueuedNow: vi.fn(),
  dispatchQueuedMessage: vi.fn(),
}));

const row = (id: string, overrides: Partial<QueueRow> = {}): QueueRow => ({
  id,
  content: `queued ${id}`,
  lastError: null,
  attachments: [],
  steerGenerationId: null,
  input: { modelId: "queued-model", searchEnabled: false, researchEnabled: true },
  ...overrides,
});

const settings = () => ({
  modelId: "composer-model" as string | null,
  setModelId: vi.fn(),
  imageModelId: "composer-image" as string | null,
  setImageModelId: vi.fn(),
  searchPreference: false as boolean | null,
  setSearchEnabled: vi.fn(),
  resetSearchEnabled: vi.fn(),
  collectionIds: ["handbook"] as ReadonlyArray<string>,
  seedCollections: vi.fn(),
  settleCollections: vi.fn(),
});

function render(
  overrides: Partial<Parameters<typeof useConversationQueue>[0]> & { state?: QueueState } = {},
) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const props = {
    conversationId: "c1",
    rows: [row("a")],
    state: "running" as QueueState,
    running: { messageId: "answer", generationId: "g1" },
    arrived: [],
    submission: async () => ({ modelId: "m1", searchEnabled: true, timeZone: "UTC" }),
    attemptFields: async () => ({}),
    prepare: vi.fn(async () => {}),
    settings: settings(),
    ...overrides,
  };
  return { props, client, ...renderHook(() => useConversationQueue(props), { wrapper }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useConversationQueue", () => {
  it.each([
    ["running", null, null],
    ["question", "Answer the questions above to continue", "Answer the questions above first"],
    ["ready", "Starting the next message…", null],
    ["stopped", "Queue paused", null],
    ["failed", "Queue paused", null],
  ] as const)("words the server's %s state", (state, reason, blocked) => {
    const { result } = render({ state });
    expect(result.current.queue.paused?.reason ?? null).toBe(reason);
    expect(result.current.queue.sendNowBlocked).toBe(blocked);
  });

  it("hides a row the stream says arrived, and marks rows steered at the running answer", () => {
    const { result } = render({
      rows: [
        row("a"),
        row("b", { steerGenerationId: "g1" }),
        row("c", { steerGenerationId: "old" }),
      ],
      arrived: [
        { id: "m", queueEntryId: "a", content: "", textOffset: 0, turnIndex: 0, attachments: [] },
      ],
    });
    expect(result.current.queue.entries.map((entry) => entry.id)).toEqual(["b", "c"]);
    // "old" names an attempt that is over; it goes next, it is not steering.
    expect([...result.current.queue.steeringIds]).toEqual(["b"]);
  });

  it("marks a row steering the moment Steer is pressed, and aims it at the running answer", async () => {
    vi.mocked(steerQueuedMessage).mockReturnValue(new Promise(() => {}));
    const { result } = render();
    act(() => result.current.queue.onSteer("a"));
    await waitFor(() => expect([...result.current.queue.steeringIds]).toEqual(["a"]));
    expect(steerQueuedMessage).toHaveBeenCalledWith({
      data: { conversationId: "c1", entryId: "a", messageId: "answer", generationId: "g1" },
    });
  });

  it("freezes what a send carries with the draft, then settles the composer", async () => {
    vi.mocked(queueMessage).mockResolvedValue({ entryId: "new" });
    const { result, props } = render();
    await act(() => result.current.submit("next", ["file-1"], true, ["skill-1"]));
    expect(queueMessage).toHaveBeenCalledWith({
      data: {
        modelId: "m1",
        searchEnabled: true,
        timeZone: "UTC",
        conversationId: "c1",
        content: "next",
        attachmentIds: ["file-1"],
        researchEnabled: true,
        skillIds: ["skill-1"],
      },
    });
    expect(props.settings.resetSearchEnabled).toHaveBeenCalledOnce();
    expect(props.settings.settleCollections).toHaveBeenCalledOnce();
  });

  it("lends an edited row its own settings and hands the composer's back after", () => {
    const { result, props } = render({
      rows: [
        row("a", {
          input: {
            modelId: "queued-model",
            imageModelId: "queued-image",
            searchEnabled: true,
            researchEnabled: false,
            collectionIds: ["col-1"],
          },
        }),
      ],
    });
    act(() => result.current.queue.onEditStart(result.current.queue.entries[0]!));
    expect(props.settings.setModelId).toHaveBeenLastCalledWith("queued-model");
    // A save rebuilds the entry from the composer, so its image model must be there too.
    expect(props.settings.setImageModelId).toHaveBeenLastCalledWith("queued-image");
    expect(props.settings.setSearchEnabled).toHaveBeenLastCalledWith(true);
    expect(props.settings.seedCollections).toHaveBeenLastCalledWith(["col-1"]);
    act(() => result.current.queue.onEditEnd());
    expect(props.settings.setModelId).toHaveBeenLastCalledWith("composer-model");
    expect(props.settings.setImageModelId).toHaveBeenLastCalledWith("composer-image");
    expect(props.settings.setSearchEnabled).toHaveBeenLastCalledWith(false);
    expect(props.settings.resetSearchEnabled).not.toHaveBeenCalled();
    // The composer's own collections come back too, not an empty selection.
    expect(props.settings.seedCollections).toHaveBeenLastCalledWith(["handbook"]);
    expect(props.settings.settleCollections).not.toHaveBeenCalled();
  });

  it("restores a default-following search preference after queued editing", () => {
    const { result, props } = render({ settings: { ...settings(), searchPreference: null } });
    act(() => result.current.queue.onEditStart(result.current.queue.entries[0]!));
    act(() => result.current.queue.onEditEnd());
    expect(props.settings.setSearchEnabled).toHaveBeenLastCalledWith(null);
  });

  it("sends this app's desktop fields with Send now and Send next", async () => {
    vi.mocked(sendQueuedNow).mockResolvedValue({ started: true });
    vi.mocked(dispatchQueuedMessage).mockResolvedValue({ started: true });
    const fields = {
      desktop: { executorId: "exec-1", browser: false },
    };
    const { result } = render({ attemptFields: async () => fields });
    act(() => result.current.queue.onSendNow("a"));
    act(() => result.current.queue.onDispatch());
    await waitFor(() => expect(dispatchQueuedMessage).toHaveBeenCalled());
    expect(sendQueuedNow).toHaveBeenCalledWith({
      data: { conversationId: "c1", entryId: "a", ...fields },
    });
    // A person asking may start after a stop.
    expect(dispatchQueuedMessage).toHaveBeenCalledWith({
      data: { conversationId: "c1", force: true, ...fields },
    });
  });

  it("saves open drafts before Send now or Send next starts an answer, and starts none if that fails", async () => {
    vi.mocked(sendQueuedNow).mockClear().mockResolvedValue({ started: true });
    vi.mocked(dispatchQueuedMessage).mockClear().mockResolvedValue({ started: true });
    const prepare = vi.fn(async () => {
      throw new Error("draft has unresolved changes");
    });
    const { result } = render({ prepare });
    act(() => result.current.queue.onSendNow("a"));
    act(() => result.current.queue.onDispatch());
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
    expect(sendQueuedNow).not.toHaveBeenCalled();
    expect(dispatchQueuedMessage).not.toHaveBeenCalled();
  });

  it("adds no second toast to a start the page already explained", async () => {
    vi.mocked(sendQueuedNow).mockClear();
    vi.mocked(toast.error).mockClear();
    const refuse = (error: Error) => {
      const view = render({
        prepare: async () => {
          throw error;
        },
      });
      act(() => view.result.current.queue.onSendNow("a"));
      return waitFor(() =>
        expect(
          view.client
            .getMutationCache()
            .getAll()
            .map((m) => m.state.status),
        ).toEqual(["error"]),
      );
    };
    await refuse(new AlreadyTold("draft has unresolved changes"));
    expect(toast.error).not.toHaveBeenCalled();
    await refuse(new Error("The folder is gone."));
    expect(vi.mocked(toast.error).mock.calls).toEqual([["The folder is gone."]]);
    expect(sendQueuedNow).not.toHaveBeenCalled();
  });
});
