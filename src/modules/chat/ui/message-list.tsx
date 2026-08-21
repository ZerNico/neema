import { useMemo } from "react";
import type { ComponentProps } from "react";
import { Streamdown } from "streamdown";
import type { ToolActivity, ToolSource } from "../client/use-message-stream.ts";
import { CitationChip } from "./citation-chip.tsx";
import { FOOTNOTE_HREF, collectSources, prepareCitedMarkdown } from "./citations.ts";
import { MessageActions } from "./message-actions.tsx";
import { ReasoningBlock } from "./reasoning-block.tsx";
import { useSourcesPanel } from "./sources-panel.tsx";
import { ToolActivityBlock } from "./tool-activity-block.tsx";
import { cn } from "~/ui/utils";

type MarkdownComponents = NonNullable<ComponentProps<typeof Streamdown>["components"]>;

// Renders GFM footnote references as citation chips and hides the footnote
// list streamdown would otherwise append (the detail panel is our sources UI).
// Both hooks into streamdown's output — the `#user-content-fn-N` href shape and
// the `data-footnotes` section — are verified against 2.5.0 by the render test;
// re-check them on upgrade.
function citationComponents(
  sources: ToolSource[],
  onOpen: (index: number) => void,
): MarkdownComponents {
  const byIndex = new Map(sources.map((s) => [s.index, s]));
  return {
    a: ({ node: _node, href, children, ...props }) => {
      const index = Number(FOOTNOTE_HREF.exec(href ?? "")?.[1]);
      const source = byIndex.get(index);
      if (!source) {
        return (
          <a href={href} {...props}>
            {children}
          </a>
        );
      }
      return <CitationChip source={source} onOpen={() => onOpen(source.index)} />;
    },
    section: ({ node, children, ...props }) => {
      // hast gives a valueless attribute the empty string, so compare against
      // undefined — a truthiness check here silently renders the list.
      const properties = node?.properties as Record<string, unknown> | undefined;
      if (properties?.dataFootnotes !== undefined) return null;
      return <section {...props}>{children}</section>;
    },
    // A chip is already superscript-sized; the extra <sup> would raise it off
    // the line and shrink it again.
    sup: ({ children }) => <>{children}</>,
  };
}

// Citation rendering needs the detail panel, so it lives in its own component
// that is only mounted when the message actually has sources — an ordinary
// answer renders through AssistantMarkdown with no panel dependency at all.
function CitedAnswer({
  message,
  sources,
  streaming,
}: {
  message: DisplayMessage;
  sources: ToolSource[];
  streaming: boolean;
}) {
  const openSources = useSourcesPanel(message.id, sources);
  const components = useMemo(
    () => citationComponents(sources, openSources),
    [sources, openSources],
  );
  const content = useMemo(
    () => prepareCitedMarkdown(message.content, sources),
    [message.content, sources],
  );
  return <AssistantMarkdown content={content} components={components} streaming={streaming} />;
}

function AssistantMarkdown({
  content,
  components,
  streaming,
}: {
  content: string;
  components?: MarkdownComponents;
  streaming: boolean;
}) {
  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      parseIncompleteMarkdown
      isAnimating={streaming}
      {...(streaming ? { caret: "block" as const } : {})}
      {...(components ? { components } : {})}
      className={cn("space-y-3 [&_pre]:overflow-x-auto")}
    >
      {content}
    </Streamdown>
  );
}

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  reasoning: string;
  /** A reasoning phase happened/is happening (even if its content is hidden). */
  reasoningSeen: boolean;
  toolActivities: ToolActivity[];
  status: string;
  /** Regenerate this message (rewinding the conversation to it). */
  onRetry?: () => void;
  /** Disables the retry button (e.g. while another generation runs). */
  retryDisabled?: boolean;
}

export function MessageBubble({ message }: { message: DisplayMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex w-full justify-end">
        <div className="bg-primary text-primary-foreground max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed">
          {message.content}
        </div>
      </div>
    );
  }
  return <AssistantBubble message={message} />;
}

function AssistantBubble({ message }: { message: DisplayMessage }) {
  const streaming = message.status === "streaming";
  const toolRunning = message.toolActivities.some((a) => a.status === "running");
  // "Thinking" is the phase before any visible answer text arrives — but not
  // while a tool is running (the tool block carries the progress feedback).
  const reasoningActive = streaming && message.content.length === 0 && !toolRunning;
  const showReasoning = message.reasoningSeen || message.reasoning.length > 0;
  // Kept referentially stable across text chunks — it feeds the memoized
  // markdown `components`, and a fresh array there would re-render the whole
  // answer on every delta.
  const sourceKey = message.toolActivities
    .map((a) => (a.sources ?? []).map((s) => s.index).join(","))
    .join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sources = useMemo(() => collectSources(message.toolActivities), [sourceKey]);

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
        ) : sources.length > 0 ? (
          <CitedAnswer message={message} sources={sources} streaming={streaming} />
        ) : (
          <AssistantMarkdown content={message.content} streaming={streaming} />
        )}
        {message.status === "error" ? (
          <p className="text-destructive mt-1 text-xs">Generation failed.</p>
        ) : null}
        {streaming ? null : (
          <MessageActions
            messageId={message.id}
            content={message.content}
            sources={sources}
            onRetry={message.onRetry}
            retryDisabled={message.retryDisabled ?? false}
          />
        )}
      </div>
    </div>
  );
}
