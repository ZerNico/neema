import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { conversationQuery } from "../client/queries.ts";
import { useMessageStream } from "../client/use-message-stream.ts";
import { sendMessage } from "../server/functions.ts";
import { Composer } from "./composer.tsx";
import { type DisplayMessage, MessageBubble } from "./message-list.tsx";

export function ChatView({ conversationId }: { conversationId: string }) {
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(conversationQuery(conversationId));
  const [modelId, setModelId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const streamingMessage = data.messages.find((m) => m.status === "streaming");
  const initialStream = useMemo(() => {
    if (!streamingMessage) return null;
    const text = data.pendingChunks.map((c) => c.delta).join("");
    const lastSeq = data.pendingChunks.at(-1)?.seq ?? 0;
    return { text, lastSeq };
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
    .map((m) =>
      m.id === streamingMessage?.id && stream.status === "streaming"
        ? { ...m, content: stream.text }
        : m.id === streamingMessage?.id && stream.text.length > m.content.length
          ? { ...m, content: stream.text, status: stream.status }
          : m,
    );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [display.length, stream.text.length]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
          {display.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
      <div className="px-4 pb-4">
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
