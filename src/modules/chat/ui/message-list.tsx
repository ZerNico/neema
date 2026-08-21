import { Streamdown } from "streamdown";
import { cn } from "~/ui/utils";

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
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

  return (
    <div className="flex w-full justify-start">
      <div className="text-foreground w-full max-w-full text-sm leading-relaxed">
        {streaming && message.content.length === 0 ? (
          <span className="text-muted-foreground animate-pulse">Thinking…</span>
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
