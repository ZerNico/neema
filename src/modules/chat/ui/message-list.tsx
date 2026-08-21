import { cn } from "~/shared/ui/utils";

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  status: string;
}

export function MessageBubble({ message }: { message: DisplayMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
          isUser ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
        )}
      >
        {message.content}
        {message.status === "streaming" && message.content.length === 0 ? (
          <span className="text-muted-foreground animate-pulse">Thinking…</span>
        ) : null}
        {message.status === "streaming" && message.content.length > 0 ? (
          <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-current align-text-bottom" />
        ) : null}
        {message.status === "error" ? (
          <span className="text-destructive block text-xs">Generation failed.</span>
        ) : null}
      </div>
    </div>
  );
}
