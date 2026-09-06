import { Alert02Icon, ArrowDown01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "react";
import { Streamdown } from "streamdown";
import {
  type CompactionActivity,
  type ResearchToolActivity,
  type ToolActivity,
  type ToolSource,
  type WebToolActivity,
} from "../client/use-message-stream.ts";
import { stripUndefinedCitationMarkers } from "../citation-markers.ts";
import { AskUserBlock, type QuestionActions } from "./ask-user-block.tsx";
import { projectAssistantBody } from "./assistant-body.ts";
import { CitationChip } from "./citation-chip.tsx";
import { CompactionBlock } from "./compaction-block.tsx";
import { ChatInput } from "./chat-input.tsx";
import {
  FOOTNOTE_HREF,
  collectSources,
  prepareCitedMarkdown,
  selectAnswerSources,
} from "./citations.ts";
import { ResearchActivityBlock } from "./research-activity-block.tsx";
import { useResearchPanel } from "./research-panel.tsx";
import { MemoryActivityBlock } from "./memory-activity-block.tsx";
import { MessageActions } from "./message-actions.tsx";
import { ReasoningBlock } from "./reasoning-block.tsx";
import { useSourcesPanel } from "./sources-panel.tsx";
import type { MessageTime } from "./timestamps.ts";
import { ToolActivityBlock } from "./tool-activity-block.tsx";
import type { AttachmentUploads } from "~/modules/attachments/client/use-attachment-uploads.ts";
import { attachmentUrl } from "~/modules/attachments/client/use-attachment-uploads.ts";
import type { MessageAttachment } from "~/modules/attachments/schema.ts";
import { markdownPlugins } from "~/ui/markdown-plugins.ts";
import { AttachmentChip, AttachmentChipRow } from "~/modules/attachments/ui/attachment-chip.tsx";
import { Button } from "~/ui/primitives/button";
import {
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  disclosureChevronMotionClassName,
  disclosureTriggerClassName,
} from "~/ui/disclosure.tsx";
import { cn } from "~/ui/utils";

type MarkdownComponents = NonNullable<ComponentProps<typeof Streamdown>["components"]>;

// Renders GFM footnote references as citation chips linking to their source,
// and hides the footnote list streamdown would otherwise append (the detail
// panel is our sources UI).
// Both hooks into streamdown's output — the `#user-content-fn-N` href shape and
// the `data-footnotes` section — are verified against 2.5.0 by the render test;
// re-check them on upgrade.
function citationComponents(sources: ToolSource[]): MarkdownComponents {
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
      return <CitationChip source={source} />;
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

// Every segment shares its message's source set.
const CitedAnswer = memo(function CitedAnswer({
  content: rawContent,
  sources,
  streaming,
}: {
  content: string;
  sources: ToolSource[];
  streaming: boolean;
}) {
  const components = useMemo(() => citationComponents(sources), [sources]);
  const content = useMemo(() => prepareCitedMarkdown(rawContent, sources), [rawContent, sources]);
  return <AssistantMarkdown content={content} components={components} streaming={streaming} />;
});

const AssistantMarkdown = memo(function AssistantMarkdown({
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
      plugins={markdownPlugins}
      isAnimating={streaming}
      animated={{ animation: "fadeIn", duration: 200, easing: "ease-out", stagger: 0 }}
      {...(components ? { components } : {})}
      className={cn("space-y-3 [&_pre]:overflow-x-auto")}
    >
      {content}
    </Streamdown>
  );
});

export interface DisplayMessage {
  id: string;
  /** Durable attempt identity, used to fence live panel updates across retries. */
  researchRunId?: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  /** Receipt length before smoothing; activity anchors remain in this coordinate space. */
  rawTextLength?: number;
  reasoning: string;
  /** A reasoning phase happened/is happening (even if its content is hidden). */
  reasoningSeen: boolean;
  toolActivities: ToolActivity[];
  status: string;
  questionActions?: QuestionActions | undefined;
  /** Sanitized failure reason stored with the message, when it failed. */
  error?: string | null;
  /**
   * Day heading to draw above this message. Set only on the message that opens
   * a local calendar day, and absent entirely until hydration — the server
   * cannot know where the visitor's days begin.
   */
  dayLabel?: string | null;
  /** Durable and live compaction occurrences inside this assistant response. */
  compactionActivities?: CompactionActivity[];
  /** Local send time for the action row; absent until hydration. */
  time?: MessageTime | null;
  editedAt?: Date | null;
  /**
   * Sources from earlier messages in the conversation. Citation numbering is
   * conversation-scoped, so a message may cite a source it didn't search for
   * itself; markers resolve against these plus the message's own sources.
   */
  inheritedSources?: ToolSource[];
  /** Files sent with this message, in position order. */
  attachments?: ReadonlyArray<MessageAttachment>;
  /** Edit this completed user message. */
  onEdit?: () => void;
  editDisabled?: boolean;
  editState?: {
    initialDraft: string;
    onSave: (draft: string) => void;
    onCancel: () => void;
    saveDisabled: boolean;
    controlsDisabled: boolean;
    modelId: string | null;
    onModelChange: (modelId: string) => void;
    searchEnabled: boolean;
    researchEnabled?: boolean;
    onSearchEnabledChange: (enabled: boolean) => void;
    /** The view-level upload state, seeded with the message's own files. */
    attachments: AttachmentUploads;
  };
  /** Fork the conversation into a new one ending at this message. */
  onBranch?: () => void;
  branchDisabled?: boolean;
  /** Regenerate this message (rewinding the conversation to it). */
  onRetry?: () => void;
  /** Regenerate it with a different model. */
  onRetryWith?: (modelId: string) => void;
  /** Model behind the response a retry would replace; marked in that menu. */
  retryModelId?: string | null;
  /** Disables the retry button (e.g. while another generation runs). */
  retryDisabled?: boolean;
}

// Separates two calendar days inside the conversation. Drawn as part of the
// message row rather than as a row of its own, so the virtualizer measures it
// along with the bubble it heads and needs no index remapping.
function DayDivider({ label }: { label: string }) {
  return (
    <div className="mb-3 mt-1 flex items-center gap-3" role="separator" aria-label={label}>
      <span className="bg-border h-px flex-1" />
      <span className="text-muted-foreground text-2xs leading-[inherit] font-medium uppercase tracking-wider">
        {label}
      </span>
      <span className="bg-border h-px flex-1" />
    </div>
  );
}

export const MessageBubble = memo(function MessageBubble({ message }: { message: DisplayMessage }) {
  return (
    <>
      {message.dayLabel ? <DayDivider label={message.dayLabel} /> : null}
      {message.role === "user" ? (
        <UserBubble message={message} />
      ) : (
        <AssistantBubble message={message} />
      )}
    </>
  );
});

// Tween only when the row swaps between its bubble and editor. The draft now
// lives inside InlineMessageEditor, so typing does not rerender this component
// or restart the measured-height animation.
function useEditSwapHeight(editing: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const wasEditing = useRef(editing);
  const lastHeight = useRef<number | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const height = element.offsetHeight;
    if (
      wasEditing.current !== editing &&
      lastHeight.current !== null &&
      lastHeight.current !== height &&
      typeof element.animate === "function" &&
      !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      element.animate(
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

function InlineMessageEditor({
  editState,
}: {
  editState: NonNullable<DisplayMessage["editState"]>;
}) {
  const [draft, setDraft] = useState(editState.initialDraft);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ChatTextarea sizes itself in its child layout effect first. Focus without
  // scrolling afterwards so the virtualizer, not the browser, owns row position.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);

  return (
    <div>
      <ChatInput
        ref={textareaRef}
        value={draft}
        onValueChange={setDraft}
        onSubmit={() => editState.onSave(draft)}
        onCancel={editState.onCancel}
        disabled={editState.saveDisabled}
        controlsDisabled={editState.controlsDisabled}
        modelId={editState.modelId}
        onModelChange={editState.onModelChange}
        searchEnabled={editState.searchEnabled}
        researchEnabled={editState.researchEnabled ?? false}
        onSearchEnabledChange={editState.onSearchEnabledChange}
        attachments={editState.attachments}
        placeholder="Edit message…"
        textareaLabel="Edit message"
        submitLabel="Save edit"
      />
    </div>
  );
}

function UserBubble({ message }: { message: DisplayMessage }) {
  const wrapperRef = useEditSwapHeight(message.editState !== undefined);

  return (
    <div ref={wrapperRef} className="w-full">
      {message.editState ? (
        <InlineMessageEditor editState={message.editState} />
      ) : (
        <div className="group/user flex w-full flex-col items-end">
          {message.attachments && message.attachments.length > 0 ? (
            <AttachmentChipRow className="mb-1.5 max-w-[80%] justify-end">
              {message.attachments.map((attachment) => (
                <AttachmentChip
                  key={attachment.id}
                  item={{
                    fileName: attachment.fileName,
                    size: attachment.size,
                    kind: attachment.kind,
                    previewUrl: attachment.kind === "image" ? attachmentUrl(attachment.id) : null,
                  }}
                  href={attachmentUrl(attachment.id)}
                  preview={attachmentUrl(attachment.id)}
                />
              ))}
            </AttachmentChipRow>
          ) : null}
          {/* An attachment-only turn has no text bubble to draw. */}
          {message.content ? (
            <div className="bg-primary text-primary-foreground max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed">
              {message.content}
            </div>
          ) : null}
          {message.editedAt ? (
            <span className="text-muted-foreground mr-1 mt-1 text-2xs leading-[inherit]">
              edited
            </span>
          ) : null}
          {/* Hover-revealed on pointer devices; always visible on touch, where
              there is no hover. focus-within keeps them keyboard-reachable. */}
          <MessageActions
            content={message.content}
            sources={[]}
            time={message.time}
            timeFirst
            onEdit={message.onEdit}
            editDisabled={message.editDisabled ?? false}
            onRetry={message.onRetry}
            onRetryWith={message.onRetryWith}
            retryModelId={message.retryModelId}
            retryDisabled={message.retryDisabled ?? false}
            className="opacity-0 transition-opacity group-hover/user:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100"
          />
        </div>
      )}
    </div>
  );
}

const AssistantBody = memo(function AssistantBody({
  message,
  sources,
  onOpenSources,
}: {
  message: DisplayMessage;
  sources: ToolSource[];
  onOpenSources?: () => void;
}) {
  const streaming = message.status === "streaming";
  const usedIndexes = useMemo(() => new Set(sources.map((source) => source.index)), [sources]);
  const { parts } = projectAssistantBody({
    content: message.content,
    rawTextLength: message.rawTextLength ?? message.content.length,
    streaming,
    tools: message.toolActivities,
    compactions: message.compactionActivities ?? EMPTY_COMPACTION_ACTIVITIES,
  });
  return parts.map((part) => {
    if (part.kind === "text") {
      return (
        <div key={part.key} className="mb-3 last:mb-0">
          {sources.length > 0 ? (
            <CitedAnswer content={part.content} sources={sources} streaming={part.streaming} />
          ) : (
            <AssistantMarkdown content={part.content} streaming={part.streaming} />
          )}
        </div>
      );
    }
    if (part.kind === "web") {
      return (
        <ToolActivityBlock
          key={part.key}
          activities={part.activities}
          usedSources={usedIndexes}
          {...(!streaming && onOpenSources ? { onViewSources: onOpenSources } : {})}
        />
      );
    }
    if (part.kind === "compaction") {
      return (
        <CompactionBlock
          key={part.key}
          status={part.activity.status}
          outcome={part.activity.outcome}
          summary={part.activity.summary}
          className="mb-2"
        />
      );
    }
    if (part.activity.family === "research") {
      const runId = part.activity.progress?.runId;
      return (
        <ResearchActivityRow
          key={part.key}
          messageId={message.id}
          activity={part.activity}
          webActivities={message.toolActivities.filter(
            (activity): activity is WebToolActivity =>
              activity.family === "web" && !!runId && activity.runId === runId,
          )}
          sourceCount={sources.length}
        />
      );
    }
    if (part.activity.family === "memory") {
      return <MemoryActivityBlock key={part.key} activity={part.activity} />;
    }
    return (
      <AskUserBlock
        key={part.key}
        activity={part.activity}
        messageStatus={message.status}
        {...message.questionActions}
      />
    );
  });
});

// Mount the panel binding beside, not around, the body: receiving the first
// source must not remount the timeline and erase open disclosures or drafts.
function AssistantSourcePanel({
  messageId,
  sources,
  bind,
}: {
  messageId: string;
  sources: ToolSource[];
  bind: (open: () => void) => () => void;
}) {
  const open = useSourcesPanel(messageId, sources);
  useLayoutEffect(() => bind(open), [bind, open]);
  return null;
}

// An opening-only trigger. The conversation owns updates after this row unmounts.
function ResearchActivityRow({
  messageId,
  activity,
  webActivities,
  sourceCount,
}: {
  messageId: string;
  activity: ResearchToolActivity;
  webActivities: WebToolActivity[];
  sourceCount: number;
}) {
  const open = useResearchPanel(messageId, activity, webActivities);
  return (
    <ResearchActivityBlock
      activity={activity}
      webActivities={webActivities}
      sourceCount={sourceCount}
      onOpen={open}
    />
  );
}

const EMPTY_COMPACTION_ACTIVITIES: CompactionActivity[] = [];

const RETRY_AFTER =
  /retry after\s+(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m)\b/i;
const RATE_LIMIT = /rate limit|too many requests|(?:http|status(?: code)?)\s*:?\s*429/i;

function retryDelay(error: string): string | null {
  const match = RETRY_AFTER.exec(error);
  if (!match) return null;

  const amount = match[1]!;
  const value = Number(amount);
  const unit = match[2]!.toLowerCase();
  if (unit === "ms" || unit.startsWith("millisecond")) {
    return `${amount} millisecond${value === 1 ? "" : "s"}`;
  }
  if (unit === "m" || unit.startsWith("min")) {
    return `${amount} minute${value === 1 ? "" : "s"}`;
  }
  return `${amount} second${value === 1 ? "" : "s"}`;
}

function generationFailureCopy(error: string | null | undefined) {
  if (error && RATE_LIMIT.test(error)) {
    const delay = retryDelay(error);
    return {
      title: "Provider is temporarily busy",
      description: delay
        ? `This model provider has reached its rate limit. Try again in ${delay}.`
        : "This model provider has reached its rate limit. Try again in a moment.",
    };
  }

  return {
    title: "Couldn’t generate a response",
    description: "Try again, or choose another model if the problem continues.",
  };
}

const FAILURE_DETAIL_PREFIXES = [
  /^ProviderUnreachable:\s*/i,
  /^effect\/ai\/AiError\/AiError:\s*/i,
  /^[A-Za-z][\w]*Client\.[A-Za-z][\w]*:\s*/,
];

function generationFailureDetails(error: string): string {
  let details = error
    .trim()
    .replace(/^Cause\(\[Fail\(/, "")
    .replace(/\)\]\)$/, "");

  for (const prefix of FAILURE_DETAIL_PREFIXES) {
    details = details.replace(prefix, "");
  }

  return details || error;
}

function GenerationFailure({
  error,
  onRetry,
  retryDisabled,
}: {
  error: string | null | undefined;
  onRetry: (() => void) | undefined;
  retryDisabled: boolean;
}) {
  const copy = generationFailureCopy(error);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const details = error ? generationFailureDetails(error) : null;

  return (
    <div
      role="alert"
      aria-atomic="true"
      className="border-border bg-muted/30 mt-3 rounded-2xl border p-3"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="bg-destructive/10 text-destructive flex size-8 shrink-0 items-center justify-center rounded-full">
            <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="size-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium leading-5">{copy.title}</p>
            <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
              {copy.description}
            </p>
            {details ? (
              <Disclosure open={detailsOpen} onOpenChange={setDetailsOpen} className="mt-2">
                <DisclosureTrigger
                  className={cn(
                    disclosureTriggerClassName,
                    "focus-visible:ring-ring/30 w-fit gap-1 rounded-lg text-xs font-medium outline-none focus-visible:ring-3",
                  )}
                >
                  <HugeiconsIcon
                    icon={ArrowDown01Icon}
                    strokeWidth={2}
                    className={cn(
                      disclosureChevronMotionClassName,
                      "size-3",
                      detailsOpen && "rotate-180",
                    )}
                    aria-hidden
                  />
                  Technical details
                </DisclosureTrigger>
                <DisclosureContent>
                  <p className="text-muted-foreground mt-1.5 [overflow-wrap:anywhere] font-mono text-2xs leading-relaxed">
                    {details}
                  </p>
                </DisclosureContent>
              </Disclosure>
            ) : null}
          </div>
        </div>
        {onRetry ? (
          <Button
            size="sm"
            variant="outline"
            onClick={onRetry}
            disabled={retryDisabled}
            className="ml-11 self-start sm:ml-0"
          >
            <HugeiconsIcon icon={RefreshIcon} data-icon="inline-start" aria-hidden />
            Try again
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function AssistantBubble({ message }: { message: DisplayMessage }) {
  const sourcePanel = useRef<(() => void) | null>(null);
  const bindSourcePanel = useCallback((open: () => void) => {
    sourcePanel.current = open;
    return () => {
      sourcePanel.current = null;
    };
  }, []);
  const openSources = useCallback(() => sourcePanel.current?.(), []);
  const streaming = message.status === "streaming";
  // A research run writing its answer is no longer "a tool running": the reply
  // is streaming like any other, so the ordinary pre-text signal applies.
  const toolRunning = message.toolActivities.some(
    (a) =>
      a.status === "running" && !(a.family === "research" && a.progress?.phase === "synthesizing"),
  );
  // "Thinking" is the phase before any visible answer text arrives — but not
  // while a tool is running (the tool block carries the progress feedback).
  const reasoningActive = streaming && message.content.length === 0 && !toolRunning;
  // "Compacting…" is already the live signal; "Thinking…" underneath it would
  // claim the model is working when nothing has been sent to it yet.
  const compactionActivities = message.compactionActivities ?? EMPTY_COMPACTION_ACTIVITIES;
  const compacting = compactionActivities.some((activity) => activity.status === "running");
  const showReasoning = message.reasoningSeen || message.reasoning.length > 0;

  // Search hits remain in activity; the answer lists cited or extracted evidence.
  const sources = useMemo(
    () =>
      selectAnswerSources(
        message.content,
        collectSources(message.toolActivities),
        message.inheritedSources ?? [],
      ),
    [message.content, message.inheritedSources, message.toolActivities],
  );

  return (
    <div className="flex w-full justify-start">
      <div className="text-foreground w-full max-w-full text-sm leading-relaxed">
        {showReasoning ? (
          <ReasoningBlock reasoning={message.reasoning} active={reasoningActive} />
        ) : null}
        {sources.length > 0 && (!streaming || message.content.length > 0) ? (
          <AssistantSourcePanel messageId={message.id} sources={sources} bind={bindSourcePanel} />
        ) : null}
        <AssistantBody
          message={message}
          sources={sources}
          {...(sources.length > 0 ? { onOpenSources: openSources } : {})}
        />
        {streaming &&
        message.content.length === 0 &&
        !showReasoning &&
        !toolRunning &&
        !compacting ? (
          <span className="text-muted-foreground animate-pulse">Thinking…</span>
        ) : null}
        {message.status === "error" ? (
          <GenerationFailure
            error={message.error}
            onRetry={message.onRetry}
            retryDisabled={message.retryDisabled ?? false}
          />
        ) : message.status === "aborted" ? (
          <p className="text-muted-foreground mt-2 text-xs">Stopped.</p>
        ) : null}
        {/* A turn that only asked a question or only ran research has nothing to
            copy and no answer to branch from; the row would be chrome around
            an empty message. Its actions return with the text. */}
        {streaming || message.content.length === 0 ? null : (
          <MessageActions
            onOpenSources={openSources}
            content={message.content}
            sources={sources}
            time={message.time}
            onBranch={message.onBranch}
            branchDisabled={message.branchDisabled ?? false}
            onRetry={message.onRetry}
            onRetryWith={message.onRetryWith}
            retryModelId={message.retryModelId}
            retryDisabled={message.retryDisabled ?? false}
          />
        )}
      </div>
    </div>
  );
}
