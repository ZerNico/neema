import { GitBranchIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { conversationQuery } from "../client/queries.ts";
import {
  applyCompactionChunk,
  useMessageStream,
  type CompactionActivity,
  type ToolActivity,
  type ToolPageStatus,
  type ToolSource,
} from "../client/use-message-stream.ts";
import {
  branchConversation,
  editMessage,
  retryMessage,
  sendMessage,
  stopGeneration,
} from "../server/functions.ts";
import { Composer } from "./composer.tsx";
import { greetingFor } from "./greeting.ts";
import { buildMessageStamps } from "./timestamps.ts";
import { useSearchMode } from "./use-search-mode.ts";
import type { DisplayMessage } from "./message-list.tsx";
import { VirtualMessageList } from "./virtual-message-list.tsx";
import { useAttachmentUploads } from "~/modules/attachments/client/use-attachment-uploads.ts";
import type { MessageAttachment } from "~/modules/attachments/schema.ts";
import { useConfirm } from "~/ui/confirm.tsx";
import { useDocumentTitle } from "~/ui/use-document-title.ts";
import { useHydrated } from "~/ui/use-hydrated.ts";
import { cn } from "~/ui/utils";

// Durable message_tool_calls row → the client-side activity shape.
function toActivity(row: {
  id: string;
  toolName: string;
  arguments: unknown;
  result: unknown;
  status: "running" | "complete" | "error";
  turnIndex: number;
  callIndex: number;
  error: { code: string; message: string } | null;
}): ToolActivity {
  const args = (row.arguments ?? {}) as { queries?: string[]; urls?: string[] };
  const result = (row.result ?? {}) as {
    targets?: string[];
    resultCount?: number;
    pagesFetched?: number;
    pages?: ToolPageStatus[];
    sources?: ToolSource[];
  };
  return {
    callId: row.id,
    name: row.toolName,
    turnIndex: row.turnIndex,
    callIndex: row.callIndex,
    targets: result.targets ?? args.queries ?? args.urls ?? [],
    status: row.status,
    ...(result.resultCount !== undefined ? { resultCount: result.resultCount } : {}),
    ...(result.pagesFetched !== undefined ? { pagesFetched: result.pagesFetched } : {}),
    ...(result.pages !== undefined ? { pages: result.pages } : {}),
    ...(result.sources !== undefined ? { sources: result.sources } : {}),
    ...(row.error ? { error: row.error.message } : {}),
  };
}

function toCompactionActivity(row: {
  id: string;
  beforeTurnIndex: number;
  passIndex: number;
  scope: "history" | "active_rounds";
  status: "running" | "complete" | "error";
  outcome: "summary" | "hard_truncation" | null;
  summary: string | null;
}): CompactionActivity {
  return {
    eventId: row.id,
    beforeTurnIndex: row.beforeTurnIndex,
    passIndex: row.passIndex,
    scope: row.scope,
    status: row.status === "error" ? "failed" : row.status,
    ...(row.outcome ? { outcome: row.outcome } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
  };
}

export function ChatView({ conversationId }: { conversationId: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { data } = useSuspenseQuery(conversationQuery(conversationId));
  // Stays in step with an asynchronously generated title: `conversation.updated`
  // invalidates this query, so the tab renames itself when the title lands.
  useDocumentTitle(data.conversation.title);
  const [modelId, setModelId] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  // One instance, mounted for the whole view: an edit opens by seeding it, so
  // the chips survive the ChatInput remount that swapping the bubble causes.
  const editUploads = useAttachmentUploads();
  const seedEditUploads = editUploads.seed;
  const resetEditUploads = editUploads.reset;
  const submitEditUploads = editUploads.submit;
  const editUploadCount = editUploads.items.length;
  const activeEditingMessage =
    editingMessageId === null
      ? null
      : (data.messages.find((message) => message.id === editingMessageId) ?? null);
  // Bumped on retry/edit: the assistant id usually stays the same, so the
  // stream hook needs a separate signal to resubscribe from seq 0.
  const [retryEpoch, setRetryEpoch] = useState(0);

  const streamingMessage = data.messages.find((m) => m.status === "streaming");
  // The row the stream overlay applies to. Sticky beyond streamingMessage:
  // when the generation finishes, the sync bus refetches the conversation and
  // the row flips to complete with its full content BEFORE the smoothed text
  // has drained — dropping the overlay at that moment would pop the tail in,
  // exactly what smoothing exists to prevent. (Guarded render-time adjust.)
  const [overlayId, setOverlayId] = useState<string | null>(null);
  if (streamingMessage && streamingMessage.id !== overlayId) {
    setOverlayId(streamingMessage.id);
  }
  // oxlint-disable react/memo-dependencies -- pendingChunks are a snapshot for this streaming generation
  const initialStream = useMemo(() => {
    if (!streamingMessage) return null;
    const text = data.pendingChunks
      .filter((c) => c.kind === "text")
      .map((c) => c.delta)
      .join("");
    const reasoningChunks = data.pendingChunks.filter((c) => c.kind === "reasoning");
    const reasoning = reasoningChunks.map((c) => c.delta).join("");
    const lastSeq = data.pendingChunks.at(-1)?.seq ?? 0;
    // Seed tool activity from durable rows; live envelopes upsert on top.
    const tools = data.toolCalls.filter((t) => t.messageId === streamingMessage.id).map(toActivity);
    // Seed durable activity first; replayed chunks then idempotently overlay
    // any terminal marker that landed after the query snapshot.
    const durableCompactions = data.compactionEvents
      .filter((event) => event.messageId === streamingMessage.id)
      .map(toCompactionActivity);
    const compactions = data.pendingChunks
      .filter((c) => c.kind === "compaction")
      .reduce<CompactionActivity[]>(
        (current, c) => applyCompactionChunk(current, c.delta),
        durableCompactions,
      );
    return {
      text,
      reasoning,
      reasoningSeen: reasoningChunks.length > 0,
      tools,
      compactions,
      lastSeq,
    };
  }, [streamingMessage?.id, retryEpoch]);
  // oxlint-enable react/memo-dependencies

  const stream = useMessageStream(
    streamingMessage?.id ?? null,
    initialStream,
    conversationId,
    retryEpoch,
  );

  const effectiveModelId = modelId ?? data.conversation.modelId;
  const {
    enabled: searchEnabled,
    setEnabled: setSearchEnabled,
    reset: resetSearchEnabled,
  } = useSearchMode(effectiveModelId);

  const sendMutation = useMutation({
    mutationFn: (input: { content: string; attachmentIds: ReadonlyArray<string> }) =>
      sendMessage({
        data: {
          conversationId,
          modelId: effectiveModelId!,
          content: input.content,
          searchEnabled,
          attachmentIds: input.attachmentIds,
        },
      }),
    onSuccess: () => {
      resetSearchEnabled();
      void queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
    },
  });

  const retryMutation = useMutation({
    // `modelId` omitted regenerates with the model that answered before; a
    // value switches models for this attempt only (the conversation default
    // and every earlier message keep theirs).
    mutationFn: (input: { messageId: string; modelId?: string }) =>
      retryMessage({ data: { conversationId, ...input } }),
    onSuccess: async () => {
      // Refetch BEFORE bumping the epoch: the retried generation restarts at
      // seq 1, so the new subscription must be seeded from the wiped message
      // (after=0), not from the previous generation's chunk cursor.
      await queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
      setRetryEpoch((e) => e + 1);
    },
  });

  // Branching leaves this conversation untouched and opens the copy, so the
  // only cache work here is making the new chat show up in the lists.
  const branchMutation = useMutation({
    mutationFn: (messageId: string) => branchConversation({ data: { conversationId, messageId } }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
      await navigate({
        to: "/chat/$conversationId",
        params: { conversationId: result.conversationId },
      });
    },
  });

  const stopMutation = useMutation({
    mutationFn: (messageId: string) => stopGeneration({ data: { conversationId, messageId } }),
    // No invalidation here: the generation finalizes itself and the `done`
    // event already carries the terminal status back through the stream hook.
  });

  const editMutation = useMutation({
    mutationFn: (input: {
      messageId: string;
      content: string;
      modelId: string;
      searchEnabled: boolean;
      attachmentIds: ReadonlyArray<string>;
    }) => editMessage({ data: { conversationId, ...input } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
      // Claimed by the edited message now — dropping the chips must not delete
      // the very attachments the message just took ownership of.
      editUploads.markClaimed();
      setEditingMessageId(null);
      resetSearchEnabled();
      setRetryEpoch((epoch) => epoch + 1);
    },
  });

  const mutateRetry = retryMutation.mutate;
  const mutateBranch = branchMutation.mutate;
  const mutateEdit = editMutation.mutate;
  const editPending = editMutation.isPending;

  // Retry rewinds the conversation to that response: retrying anything but
  // the last one deletes the messages after it, so it asks first.
  const lastAssistantId = [...data.messages].reverse().find((m) => m.role === "assistant")?.id;
  const generating = sendMutation.isPending || stream.status === "streaming";
  const mutationPending =
    sendMutation.isPending ||
    retryMutation.isPending ||
    editMutation.isPending ||
    branchMutation.isPending;
  const actionsDisabled =
    generating ||
    retryMutation.isPending ||
    editMutation.isPending ||
    branchMutation.isPending ||
    activeEditingMessage !== null;
  const retry = useCallback(
    async (messageId: string, pickedModelId?: string) => {
      if (
        messageId !== lastAssistantId &&
        !(await confirm({
          title: "Retry this response?",
          description: "All messages after it will be removed.",
          confirmLabel: "Retry",
        }))
      ) {
        return;
      }
      mutateRetry(
        pickedModelId === undefined ? { messageId } : { messageId, modelId: pickedModelId },
      );
    },
    [confirm, lastAssistantId, mutateRetry],
  );
  const branchAt = useCallback((messageId: string) => mutateBranch(messageId), [mutateBranch]);

  // Only offered for a generation this client can actually see running.
  const stoppableId = stream.status === "streaming" ? streamingMessage?.id : undefined;

  // System messages never render, so the day headings have to be computed over
  // the list as shown — otherwise a day opened by a hidden message would lose
  // its heading.
  const visibleMessages = useMemo(
    () => data.messages.filter((m) => m.role !== "system"),
    [data.messages],
  );

  // Day boundaries and clock times are timezone-dependent, so they can only be
  // built once the browser has taken rendering over; formatting them during
  // SSR would hydrate into a mismatch. Recomputed per query result, which also
  // refreshes "Today"/"Yesterday" on every bit of activity.
  const hydrated = useHydrated();
  const stamps = useMemo(
    () => (hydrated ? buildMessageStamps(visibleMessages) : null),
    [hydrated, visibleMessages],
  );

  const attachmentsByMessage = useMemo(() => {
    const grouped = new Map<string, MessageAttachment[]>();
    for (const attachment of data.attachments) {
      const list = grouped.get(attachment.messageId);
      if (list) list.push(attachment);
      else grouped.set(attachment.messageId, [attachment]);
    }
    return grouped;
  }, [data.attachments]);

  // Grouped once per query result — the display map below runs on every
  // stream chunk and must not rescan the flat list per message.
  const toolCallsByMessage = useMemo(() => {
    const grouped = new Map<string, ToolActivity[]>();
    for (const row of data.toolCalls) {
      const activity = toActivity(row);
      const list = grouped.get(row.messageId);
      if (list) list.push(activity);
      else grouped.set(row.messageId, [activity]);
    }
    return grouped;
  }, [data.toolCalls]);

  const compactionsByMessage = useMemo(() => {
    const grouped = new Map<string, CompactionActivity[]>();
    for (const row of data.compactionEvents) {
      const activity = toCompactionActivity(row);
      const list = grouped.get(row.messageId);
      if (list) list.push(activity);
      else grouped.set(row.messageId, [activity]);
    }
    return grouped;
  }, [data.compactionEvents]);

  // messageId -> id of the next assistant message after it, in one pass.
  const nextAssistantAfter = useMemo(() => {
    const next = new Map<string, string>();
    for (let i = data.messages.length - 1; i >= 0; i--) {
      const message = data.messages[i]!;
      const following = data.messages[i + 1];
      const inherited = following ? next.get(following.id) : undefined;
      const value = following?.role === "assistant" ? following.id : inherited;
      if (value !== undefined) next.set(message.id, value);
    }
    return next;
  }, [data.messages]);

  const openEdit = useCallback(
    (messageId: string) => {
      setEditingMessageId(messageId);
      // Seeded as existing/claimed: removing one only drops it from the
      // replacement set, it is released by the save itself.
      seedEditUploads(attachmentsByMessage.get(messageId) ?? []);
    },
    [attachmentsByMessage, seedEditUploads],
  );

  const closeEdit = useCallback(() => {
    setEditingMessageId(null);
    // Anything uploaded for this edit and never sent is deleted here.
    resetEditUploads();
  }, [resetEditUploads]);

  // Which model wrote each answer — null once its row is gone. The retry menu
  // marks it, and a retry that omits a model reuses it server-side.
  const modelByMessage = useMemo(
    () => new Map(data.messages.map((m) => [m.id, m.modelId])),
    [data.messages],
  );

  const saveEdit = useCallback(
    async (draft: string) => {
      if (!activeEditingMessage) return;
      const content = draft.trim();
      if (!effectiveModelId || editPending) return;
      if (!content && editUploadCount === 0) return;

      const messageIndex = data.messages.findIndex(
        (message) => message.id === activeEditingMessage.id,
      );
      const after = data.messages.slice(messageIndex + 1);
      const responseIndex = after.findIndex((message) => message.role === "assistant");
      const removesLaterTurns =
        responseIndex === -1 ? after.length > 0 : after.slice(responseIndex + 1).length > 0;
      if (
        removesLaterTurns &&
        !(await confirm({
          title: "Edit this message?",
          description: "All messages after its response will be removed.",
          confirmLabel: "Save and regenerate",
        }))
      ) {
        return;
      }

      // Queues behind any upload still in flight, then sends the full ordered
      // replacement set — omitted ids are released server-side.
      submitEditUploads((attachmentIds) => {
        if (!content && attachmentIds.length === 0) return;
        mutateEdit({
          messageId: activeEditingMessage.id,
          content,
          modelId: effectiveModelId,
          searchEnabled,
          attachmentIds,
        });
      });
    },
    [
      activeEditingMessage,
      confirm,
      data.messages,
      editPending,
      editUploadCount,
      effectiveModelId,
      mutateEdit,
      searchEnabled,
      submitEditUploads,
    ],
  );

  // Durable rows change only with query data or global action availability. Live
  // stream and edit state are layered below so every unrelated row keeps its
  // object identity across stream chunks and local editor updates.
  const baseDisplay = useMemo(() => {
    // Citation numbering is conversation-scoped: each message inherits every
    // source discovered before it, deduplicated by index and message order.
    const inheritedByIndex = new Map<number, ToolSource>();

    return visibleMessages.map((message): DisplayMessage => {
      const reasoning = message.reasoning ?? "";
      const toolActivities = toolCallsByMessage.get(message.id) ?? [];
      const compactionActivities = compactionsByMessage.get(message.id) ?? [];
      const retryTarget =
        message.role === "assistant" ? message.id : nextAssistantAfter.get(message.id);
      const inheritedSources = [...inheritedByIndex.values()];
      for (const activity of toolActivities) {
        for (const source of activity.sources ?? []) {
          if (!inheritedByIndex.has(source.index)) inheritedByIndex.set(source.index, source);
        }
      }
      const stamp = stamps?.get(message.id);

      return {
        ...message,
        error: message.error?.message ?? null,
        ...(stamp
          ? {
              dayLabel: stamp.dayLabel,
              time: { iso: stamp.iso, clock: stamp.clock, absolute: stamp.absolute },
            }
          : {}),
        reasoning,
        reasoningSeen: reasoning.length > 0,
        toolActivities,
        inheritedSources,
        compactionActivities,
        ...(attachmentsByMessage.has(message.id)
          ? { attachments: attachmentsByMessage.get(message.id)! }
          : {}),
        ...(message.role === "user" && message.status === "complete"
          ? {
              onEdit: () => openEdit(message.id),
              editDisabled: actionsDisabled,
            }
          : {}),
        // Only the answer itself can be forked, and only once it is finished —
        // the server insists on the same, this just keeps the row honest.
        ...(message.role === "assistant" && message.status !== "streaming"
          ? {
              onBranch: () => branchAt(message.id),
              branchDisabled: actionsDisabled,
            }
          : {}),
        ...(retryTarget !== undefined
          ? {
              onRetry: () => void retry(retryTarget),
              onRetryWith: (pickedModelId: string) => void retry(retryTarget, pickedModelId),
              retryModelId: modelByMessage.get(retryTarget) ?? null,
              retryDisabled: actionsDisabled,
            }
          : {}),
      };
    });
  }, [
    actionsDisabled,
    attachmentsByMessage,
    branchAt,
    compactionsByMessage,
    modelByMessage,
    nextAssistantAfter,
    openEdit,
    retry,
    stamps,
    toolCallsByMessage,
    visibleMessages,
  ]);

  const liveId = streamingMessage?.id ?? (stream.status === "streaming" ? overlayId : null);
  const display = useMemo(
    () =>
      baseDisplay.map((base): DisplayMessage => {
        let projected = base;

        if (activeEditingMessage?.id === base.id) {
          projected = {
            ...projected,
            editState: {
              initialDraft: activeEditingMessage.content,
              onSave: (draft) => void saveEdit(draft),
              onCancel: closeEdit,
              saveDisabled: editPending,
              controlsDisabled: editPending,
              modelId: effectiveModelId,
              onModelChange: setModelId,
              searchEnabled,
              onSearchEnabledChange: setSearchEnabled,
              attachments: editUploads,
            },
          };
        }

        if (base.id !== liveId) return projected;

        // Overlay live stream state onto only the active assistant row.
        const live = {
          ...projected,
          reasoning: stream.reasoning,
          reasoningSeen: stream.reasoningSeen || base.reasoningSeen,
          toolActivities: stream.tools.length > 0 ? stream.tools : base.toolActivities,
          compactionActivities: stream.compactions,
        };
        // Status comes from the stream, not the row: the refetched row says
        // complete while the last words are still landing.
        if (stream.status === "streaming") {
          return { ...live, content: stream.text, status: "streaming" };
        }
        if (stream.text.length > base.content.length) {
          return { ...live, content: stream.text, status: stream.status };
        }
        return live;
      }),
    [
      activeEditingMessage,
      baseDisplay,
      closeEdit,
      editPending,
      editUploads,
      effectiveModelId,
      liveId,
      saveEdit,
      searchEnabled,
      setSearchEnabled,
      stream.compactions,
      stream.reasoning,
      stream.reasoningSeen,
      stream.status,
      stream.text,
      stream.tools,
    ],
  );

  return (
    <div className="flex h-full flex-col">
      {data.branchedFrom ? (
        // Outside the scroller, on the message column's geometry: lineage is a
        // property of the conversation, not of its first message.
        <div className="[scrollbar-gutter:stable_both-edges]">
          <div className="text-muted-foreground mx-auto flex w-full max-w-3xl items-center gap-1.5 px-4 pb-2 pt-1 text-xs">
            <HugeiconsIcon icon={GitBranchIcon} className="size-3.5 shrink-0" />
            <span className="shrink-0">Branched from</span>
            <Link
              to="/chat/$conversationId"
              params={{ conversationId: data.branchedFrom.conversationId }}
              className="hover:text-foreground min-w-0 truncate underline underline-offset-2"
            >
              {data.branchedFrom.title ?? "New chat…"}
            </Link>
          </div>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {/* lastSeq covers tool-activity-only updates too */}
        <VirtualMessageList messages={display} followKey={stream.lastSeq} />
      </div>
      {/* Mirrors the message column (scrollbar gutter + max-w + px) so the
          composer edges align exactly with message content above. No top
          padding: the scroller's fade mask handles the visual transition. */}
      <div className="pb-4 [scrollbar-gutter:stable_both-edges]">
        <div className="mx-auto w-full max-w-3xl px-4">
          <Composer
            onSend={(content, attachmentIds) =>
              sendMutation.mutateAsync({ content, attachmentIds })
            }
            {...(stoppableId ? { onStop: () => stopMutation.mutate(stoppableId) } : {})}
            disabled={actionsDisabled}
            textareaDisabled={activeEditingMessage !== null}
            controlsDisabled={mutationPending}
            modelId={effectiveModelId}
            onModelChange={setModelId}
            searchEnabled={searchEnabled}
            onSearchEnabledChange={setSearchEnabled}
          />
        </div>
      </div>
    </div>
  );
}

// How long the composer takes to travel from the middle of the column down to
// the bottom. Navigation waits this out, so a fast first response cannot swap
// the route in mid-slide — which would read as a jump rather than a move.
const SLIDE_MS = 380;

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);

export function NewChatView({ user }: { user: { name: string } }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [modelId, setModelId] = useState<string | null>(null);
  const { enabled: searchEnabled, setEnabled: setSearchEnabled } = useSearchMode(modelId);
  // Flipped the moment the first message actually leaves: the composer drops
  // into the position it occupies in ChatView, so the route swap that follows
  // lands on geometry that already matches.
  const [sending, setSending] = useState(false);
  // Resolves when the slide is over. A ref because the mutation callbacks that
  // await it are created once, not per render.
  const slide = useRef<Promise<void>>(Promise.resolve());

  const sendMutation = useMutation({
    mutationFn: (input: { content: string; attachmentIds: ReadonlyArray<string> }) =>
      sendMessage({
        data: {
          conversationId: null,
          modelId: modelId!,
          content: input.content,
          searchEnabled,
          attachmentIds: input.attachmentIds,
        },
      }),
    // Fires when the request starts, i.e. after any queued upload settled —
    // the composer should not move while it is still waiting on those.
    onMutate: () => {
      setSending(true);
      slide.current = prefersReducedMotion()
        ? Promise.resolve()
        : new Promise((resolve) => setTimeout(resolve, SLIDE_MS));
    },
    // The draft and its chips survive a failure, so the composer travels back
    // up to where the user left it.
    onError: () => setSending(false),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["conversations"] }),
        slide.current,
      ]);
      await navigate({
        to: "/chat/$conversationId",
        params: { conversationId: result.conversationId },
      });
    },
  });

  return (
    <div className="flex h-full flex-col">
      {/* Anchored to the bottom of its share of the column, so the greeting
          keeps its distance from the composer while both travel down. */}
      <div className="flex min-h-0 flex-1 flex-col justify-end px-4 pb-6">
        <h1
          className={cn(
            "text-muted-foreground text-center text-2xl font-medium transition-all duration-200 ease-out motion-reduce:transition-none",
            sending ? "translate-y-1 opacity-0" : "translate-y-0 opacity-100",
          )}
        >
          {greetingFor(user.name)}
        </h1>
      </div>
      {/* Mirrors ChatView's composer wrapper exactly — same scrollbar gutter,
          max width and bottom padding — so the slide ends on the next route's
          resting position instead of near it. */}
      <div className="pb-4 [scrollbar-gutter:stable_both-edges]">
        <div className="mx-auto w-full max-w-3xl px-4">
          <Composer
            onSend={(content, attachmentIds) =>
              sendMutation.mutateAsync({ content, attachmentIds })
            }
            disabled={sendMutation.isPending}
            modelId={modelId}
            onModelChange={setModelId}
            searchEnabled={searchEnabled}
            onSearchEnabledChange={setSearchEnabled}
          />
        </div>
      </div>
      {/* An equal share with the block above is what centres the composer;
          collapsing it to nothing is what carries the composer down.
          `flex-grow` is an animatable number, so this is one cheap property
          transition rather than a measured layout animation. */}
      <div
        className="min-h-0 basis-0 transition-[flex-grow] ease-in-out motion-reduce:transition-none"
        style={{ flexGrow: sending ? 0 : 1, transitionDuration: `${SLIDE_MS}ms` }}
      />
    </div>
  );
}
