import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { conversationQuery } from "../client/queries.ts";
import { useMessageStream } from "../client/use-message-stream.ts";
import { sendMessage } from "../server/functions.ts";
import { Composer } from "./composer.tsx";
import type { DisplayMessage } from "./message-list.tsx";
import { VirtualMessageList } from "./virtual-message-list.tsx";

export function ChatView({ conversationId }: { conversationId: string }) {
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(conversationQuery(conversationId));
  const [modelId, setModelId] = useState<string | null>(null);

  const streamingMessage = data.messages.find((m) => m.status === "streaming");
  const initialStream = useMemo(() => {
    if (!streamingMessage) return null;
    const text = data.pendingChunks
      .filter((c) => c.kind !== "reasoning")
      .map((c) => c.delta)
      .join("");
    const reasoningChunks = data.pendingChunks.filter((c) => c.kind === "reasoning");
    const reasoning = reasoningChunks.map((c) => c.delta).join("");
    const lastSeq = data.pendingChunks.at(-1)?.seq ?? 0;
    return { text, reasoning, reasoningSeen: reasoningChunks.length > 0, lastSeq };
    // pendingChunks are a snapshot for this streaming message id
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamingMessage?.id]);

  const stream = useMessageStream(streamingMessage?.id ?? null, initialStream, conversationId);

  const effectiveModelId = modelId ?? data.conversation.modelId;

  const sendMutation = useMutation({
    mutationFn: (content: string) =>
      sendMessage({
        data: { conversationId, modelId: effectiveModelId!, content },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] }),
  });

  const display: DisplayMessage[] = data.messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      const reasoning = m.reasoning ?? "";
      const base = { ...m, reasoning, reasoningSeen: reasoning.length > 0 };
      if (m.id !== streamingMessage?.id) return base;
      // Overlay live stream state onto the streaming message row.
      const live = {
        ...base,
        reasoning: stream.reasoning,
        reasoningSeen: stream.reasoningSeen || base.reasoningSeen,
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
        <VirtualMessageList
          messages={display}
          followKey={stream.text.length + stream.reasoning.length}
        />
      </div>
      <div className="px-4 pb-4 pt-2">
        <Composer
          onSend={(content) => sendMutation.mutate(content)}
          disabled={sendMutation.isPending || stream.status === "streaming"}
          modelId={effectiveModelId}
          onModelChange={setModelId}
        />
      </div>
    </div>
  );
}

export function NewChatView() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [modelId, setModelId] = useState<string | null>(null);

  const sendMutation = useMutation({
    mutationFn: (content: string) =>
      sendMessage({ data: { conversationId: null, modelId: modelId!, content } }),
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
      <div className="px-4 pb-4">
        <Composer
          onSend={(content) => sendMutation.mutate(content)}
          disabled={sendMutation.isPending}
          modelId={modelId}
          onModelChange={setModelId}
        />
      </div>
    </div>
  );
}
