import { Streamdown } from "streamdown";
import type { ToolActivity } from "../client/use-message-stream.ts";
import { ReasoningBlock } from "./reasoning-block.tsx";
import { ToolActivityBlock } from "./tool-activity-block.tsx";
import { cn } from "~/ui/utils";

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  reasoning: string;
  /** A reasoning phase happened/is happening (even if its content is hidden). */
  reasoningSeen: boolean;
  toolActivities: ToolActivity[];
  status: string;
}

export function MessageBubble({ message }: { message: DisplayMessage }) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex w-full justify-end">
        <div className="bg-primary text-primary-foreground max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed">
          {message.content}
        </div>
      </div>
    );
  }

  const streaming = message.status === "streaming";
  const toolRunning = message.toolActivities.some((a) => a.status === "running");
  // "Thinking" is the phase before any visible answer text arrives — but not
  // while a tool is running (the tool block carries the progress feedback).
  const reasoningActive = streaming && message.content.length === 0 && !toolRunning;
  const showReasoning = message.reasoningSeen || message.reasoning.length > 0;

  return (
    <div className="flex w-full justify-start">
      <div className="text-foreground w-full max-w-full text-sm leading-relaxed">
        {showReasoning ? (
          <ReasoningBlock reasoning={message.reasoning} active={reasoningActive} />
        ) : null}
        <ToolActivityBlock activities={message.toolActivities} />
        {streaming && message.content.length === 0 ? (
          showReasoning || toolRunning ? null : (
            <span className="text-muted-foreground animate-pulse">Thinking…</span>
          )
        ) : (
          <Streamdown
            mode={streaming ? "streaming" : "static"}
            parseIncompleteMarkdown
            isAnimating={streaming}
            {...(streaming ? { caret: "block" as const } : {})}
            className={cn("space-y-3 [&_pre]:overflow-x-auto")}
          >
            {message.content}
          </Streamdown>
        )}
        {message.status === "error" ? (
          <p className="text-destructive mt-1 text-xs">Generation failed.</p>
        ) : null}
      </div>
    </div>
  );
}
