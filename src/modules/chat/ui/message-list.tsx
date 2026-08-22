import { useLayoutEffect, useMemo, useRef } from "react";
import type { ComponentProps } from "react";
import { Streamdown } from "streamdown";
import type { ToolActivity, ToolSource } from "../client/use-message-stream.ts";
import { stripUndefinedCitationMarkers } from "../citation-markers.ts";
import { CitationChip } from "./citation-chip.tsx";
import { ChatInput } from "./chat-input.tsx";
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
  content: rawContent,
  components,
  streaming,
}: {
  content: string;
  components?: MarkdownComponents;
  streaming: boolean;
}) {
  // No source list (no components override) means any `[^N]` the model wrote
  // has nothing to resolve against and would render as literal text — the
  // model sometimes imitates cited turns earlier in the conversation. Markers
  // it backed with its own definitions are real footnotes and stay.
  const content = useMemo(
    () => (components ? rawContent : stripUndefinedCitationMarkers(rawContent)),
    [components, rawContent],
  );
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
  editedAt?: Date | null;
  /**
   * Sources from earlier messages in the conversation. Citation numbering is
   * conversation-scoped, so a message may cite a source it didn't search for
   * itself; markers resolve against these plus the message's own sources.
   */
  inheritedSources?: ToolSource[];
  /** Edit this completed user message. */
  onEdit?: () => void;
  editDisabled?: boolean;
  editState?: {
    draft: string;
    onDraftChange: (draft: string) => void;
    onSave: () => void;
    onCancel: () => void;
    saveDisabled: boolean;
    controlsDisabled: boolean;
    modelId: string | null;
    onModelChange: (modelId: string) => void;
    searchEnabled: boolean;
    onSearchEnabledChange: (enabled: boolean) => void;
  };
  /** Regenerate this message (rewinding the conversation to it). */
  onRetry?: () => void;
  /** Disables the retry button (e.g. while another generation runs). */
  retryDisabled?: boolean;
}

export function MessageBubble({ message }: { message: DisplayMessage }) {
  if (message.role === "user") {
    return <UserBubble message={message} />;
  }
  return <AssistantBubble message={message} />;
}

// Tweens the wrapper's height when `editing` flips. The virtual list measures
// rows with a ResizeObserver, so a gradual height change carries the rows
// below along frame by frame — but only `height` may be animated here; the
// virtualizer owns the row's transform.
function useEditSwapHeight(editing: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const wasEditing = useRef(editing);
  const lastHeight = useRef<number | null>(null);

  // No dependency array: re-measure after every render so the recorded height
  // tracks draft growth and streaming reflows, not just the edit toggle.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const height = el.offsetHeight;
    if (
      wasEditing.current !== editing &&
      lastHeight.current !== null &&
      lastHeight.current !== height &&
      typeof el.animate === "function" &&
      !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      // The outgoing state unmounts in the same commit, so a true cross-fade
      // has nothing left to fade out; fading the incoming state in from
      // transparent while the height morphs reads as one.
      el.animate(
        [
          { height: `${lastHeight.current}px`, opacity: 0, overflow: "hidden" },
          { height: `${height}px`, opacity: 1, overflow: "hidden" },
        ],
        { duration: 180, easing: "ease-in-out" },
      );
    }
    wasEditing.current = editing;
    lastHeight.current = height;
  });

  return ref;
}

function UserBubble({ message }: { message: DisplayMessage }) {
  const wrapperRef = useEditSwapHeight(message.editState !== undefined);

  return (
    <div ref={wrapperRef} className="w-full">
      {message.editState ? (
        <ChatInput
          value={message.editState.draft}
          onValueChange={message.editState.onDraftChange}
          onSubmit={message.editState.onSave}
          onCancel={message.editState.onCancel}
          disabled={message.editState.saveDisabled}
          controlsDisabled={message.editState.controlsDisabled}
          modelId={message.editState.modelId}
          onModelChange={message.editState.onModelChange}
          searchEnabled={message.editState.searchEnabled}
          onSearchEnabledChange={message.editState.onSearchEnabledChange}
          placeholder="Edit message…"
          autoFocus
          submitLabel="Save edit"
        />
      ) : (
        <div className="group/user flex w-full flex-col items-end">
          <div className="bg-primary text-primary-foreground max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed">
            {message.content}
          </div>
          {message.editedAt ? (
            <span className="text-muted-foreground mr-1 mt-1 text-[0.6875rem]">edited</span>
          ) : null}
          {/* Hover-revealed on pointer devices; always visible on touch, where
              there is no hover. focus-within keeps them keyboard-reachable. */}
          <MessageActions
            messageId={message.id}
            content={message.content}
            sources={[]}
            onEdit={message.onEdit}
            editDisabled={message.editDisabled ?? false}
            onRetry={message.onRetry}
            retryDisabled={message.retryDisabled ?? false}
            className="opacity-0 transition-opacity group-hover/user:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100"
          />
        </div>
      )}
    </div>
  );
}

function AssistantBubble({ message }: { message: DisplayMessage }) {
  const streaming = message.status === "streaming";
  const toolRunning = message.toolActivities.some((a) => a.status === "running");
  // "Thinking" is the phase before any visible answer text arrives — but not
  // while a tool is running (the tool block carries the progress feedback).
  const reasoningActive = streaming && message.content.length === 0 && !toolRunning;
  const showReasoning = message.reasoningSeen || message.reasoning.length > 0;

  // The message's citable set: its own searched sources (always shown, even
  // uncited — they were consulted) plus inherited sources it actually cites.
  // Numbering is conversation-scoped, so indexes never collide across the two.
  // Memo key covers both inputs that can change while streaming: own sources
  // arriving and new markers appearing in the text.
  const citedIndexes = [...message.content.matchAll(/\[\^(\d+)\]/g)].map((m) => Number(m[1]));
  const sourceKey =
    message.toolActivities.map((a) => (a.sources ?? []).map((s) => s.index).join(",")).join("|") +
    `:${[...new Set(citedIndexes)].join(",")}:${message.inheritedSources?.length ?? 0}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sources = useMemo(() => {
    const own = collectSources(message.toolActivities);
    const ownIndexes = new Set(own.map((s) => s.index));
    const cited = new Set(citedIndexes);
    const inherited = (message.inheritedSources ?? []).filter(
      (s) => cited.has(s.index) && !ownIndexes.has(s.index),
    );
    // oxlint-disable-next-line no-array-sort -- fresh array
    return [...own, ...inherited].sort((a, b) => a.index - b.index);
  }, [sourceKey]);

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
