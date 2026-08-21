import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { conversationQuery } from "../client/queries.ts";
import {
  useMessageStream,
  type ToolActivity,
  type ToolPageStatus,
  type ToolSource,
} from "../client/use-message-stream.ts";
import { retryMessage, sendMessage } from "../server/functions.ts";
import { Composer } from "./composer.tsx";
import type { DisplayMessage } from "./message-list.tsx";
import { VirtualMessageList } from "./virtual-message-list.tsx";
import { useConfirm } from "~/ui/confirm.tsx";

// Durable message_tool_calls row → the client-side activity shape.
function toActivity(row: {
  id: string;
  toolName: string;
  arguments: unknown;
  result: unknown;
  status: "running" | "complete" | "error";
  error: { code: string; message: string } | null;
}): ToolActivity {
  const args = (row.arguments ?? {}) as { query?: string };
  const result = (row.result ?? {}) as {
    query?: string;
    resultCount?: number;
    pagesFetched?: number;
    pages?: ToolPageStatus[];
    sources?: ToolSource[];
  };
  return {
    callId: row.id,
    name: row.toolName,
    query: result.query ?? args.query ?? "",
    status: row.status,
    ...(result.resultCount !== undefined ? { resultCount: result.resultCount } : {}),
    ...(result.pagesFetched !== undefined ? { pagesFetched: result.pagesFetched } : {}),
    ...(result.pages !== undefined ? { pages: result.pages } : {}),
    ...(result.sources !== undefined ? { sources: result.sources } : {}),
    ...(row.error ? { error: row.error.message } : {}),
  };
}

export function ChatView({ conversationId }: { conversationId: string }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { data } = useSuspenseQuery(conversationQuery(conversationId));
  const [modelId, setModelId] = useState<string | null>(null);
  const [searchEnabled, setSearchEnabled] = useState(false);
  // Bumped on retry: the message id stays the same, so the stream hook needs
  // a separate signal to drop old state and resubscribe from seq 0.
  const [retryEpoch, setRetryEpoch] = useState(0);

  const streamingMessage = data.messages.find((m) => m.status === "streaming");
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
    return { text, reasoning, reasoningSeen: reasoningChunks.length > 0, tools, lastSeq };
    // pendingChunks are a snapshot for this streaming generation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamingMessage?.id, retryEpoch]);

  const stream = useMessageStream(
    streamingMessage?.id ?? null,
    initialStream,
    conversationId,
    retryEpoch,
  );

  const effectiveModelId = modelId ?? data.conversation.modelId;

  const sendMutation = useMutation({
    mutationFn: (content: string) =>
      sendMessage({
        data: { conversationId, modelId: effectiveModelId!, content, searchEnabled },
      }),
    onSuccess: () => {
      setSearchEnabled(false); // per-message choice
      void queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
    },
  });

  const retryMutation = useMutation({
    mutationFn: (messageId: string) => retryMessage({ data: { conversationId, messageId } }),
    onSuccess: async () => {
      // Refetch BEFORE bumping the epoch: the retried generation restarts at
      // seq 1, so the new subscription must be seeded from the wiped message
      // (after=0), not from the previous generation's chunk cursor.
      await queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
      setRetryEpoch((e) => e + 1);
    },
  });

  // Retry rewinds the conversation to that response: retrying anything but
  // the last one deletes the messages after it, so it asks first.
  const lastAssistantId = [...data.messages].reverse().find((m) => m.role === "assistant")?.id;
  const generating = sendMutation.isPending || stream.status === "streaming";
  const retry = async (messageId: string) => {
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
    retryMutation.mutate(messageId);
  };

  // Retrying a user message regenerates the assistant response that follows
  // it (the retry target is always an assistant message server-side).
  const responseAfter = (messageId: string) => {
    const index = data.messages.findIndex((m) => m.id === messageId);
    return data.messages.slice(index + 1).find((m) => m.role === "assistant")?.id;
  };

  const display: DisplayMessage[] = data.messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      const reasoning = m.reasoning ?? "";
      const toolActivities = data.toolCalls.filter((t) => t.messageId === m.id).map(toActivity);
      const retryTarget = m.role === "assistant" ? m.id : responseAfter(m.id);
      const base: DisplayMessage = {
        ...m,
        reasoning,
        reasoningSeen: reasoning.length > 0,
        toolActivities,
        ...(retryTarget !== undefined
          ? {
              onRetry: () => void retry(retryTarget),
              retryDisabled: generating || retryMutation.isPending,
            }
          : {}),
      };
      if (m.id !== streamingMessage?.id) return base;
      // Overlay live stream state onto the streaming message row.
      const live = {
        ...base,
        reasoning: stream.reasoning,
        reasoningSeen: stream.reasoningSeen || base.reasoningSeen,
        toolActivities: stream.tools.length > 0 ? stream.tools : toolActivities,
      };
      if (stream.status === "streaming") return { ...live, content: stream.text };
      if (stream.text.length > m.content.length) {
        return { ...live, content: stream.text, status: stream.status };
      }
      return live;
    });

  return (
    <div className="flex h-full flex-col">
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
            onSend={(content) => sendMutation.mutate(content)}
            disabled={sendMutation.isPending || stream.status === "streaming"}
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

export function NewChatView() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [modelId, setModelId] = useState<string | null>(null);
  const [searchEnabled, setSearchEnabled] = useState(false);

  const sendMutation = useMutation({
    mutationFn: (content: string) =>
      sendMessage({ data: { conversationId: null, modelId: modelId!, content, searchEnabled } }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
      await navigate({
        to: "/chat/$conversationId",
        params: { conversationId: result.conversationId },
      });
    },
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 items-center justify-center">
        <h1 className="text-muted-foreground text-2xl font-medium">What can I help with?</h1>
      </div>
      <div className="mx-auto w-full max-w-3xl px-4 pb-4">
        <Composer
          onSend={(content) => sendMutation.mutate(content)}
          disabled={sendMutation.isPending}
          modelId={modelId}
          onModelChange={setModelId}
          searchEnabled={searchEnabled}
          onSearchEnabledChange={setSearchEnabled}
        />
      </div>
    </div>
  );
}
