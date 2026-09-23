import { SkillActivityBlock } from "./skill-activity-block.tsx";
import { responseFailureCopy } from "../generation-failure.ts";
import type { AssistantFile } from "../assistant-output.ts";
import { Alert02Icon, ArrowDown01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  type CompactionActivity,
  type ResearchToolActivity,
  type ToolActivity,
  type ToolSource,
} from "../client/use-message-stream.ts";
import { AssistantMarkdown, type MarkdownComponents } from "./assistant-markdown.tsx";
import { AskUserBlock, type QuestionActions } from "./ask-user-block.tsx";
import { projectAssistantBody, type AssistantSteer } from "./assistant-body.ts";
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
import { useResearchPanel, type ResearchStepActivity } from "./research-panel.tsx";
import type { SkillSummary } from "~/modules/skills/schema.ts";
import { CollectionChip, ReferenceChip, ContextChip, type ComposerContext } from "./context-picker.tsx";
import { extractReferences, restoreReferences } from "../references.ts";
import { KnowledgeActivityBlock } from "./knowledge-activity-block.tsx";
import { PlanActivityBlock } from "./plan-activity-block.tsx";
import { AgentDraftActivityBlock } from "./agent-draft-activity-block.tsx";
import { ScheduleDraftActivityBlock } from "./schedule-draft-activity-block.tsx";
import { DocumentActivityBlock } from "./document-activity-block.tsx";
import { CustomToolActivityBlock } from "./custom-tool-activity-block.tsx";
import { MemoryActivityBlock } from "./memory-activity-block.tsx";
import { DesktopActivityBlock, type DesktopApprovalRequest } from "./desktop-activity-block.tsx";
import { MessageActions } from "./message-actions.tsx";
import { ReasoningBlock } from "./reasoning-block.tsx";
import { useSourcesPanel } from "./sources-panel.tsx";
import type { MessageTime } from "./timestamps.ts";
import { ToolActivityBlock } from "./tool-activity-block.tsx";
import type { AttachmentUploads } from "~/modules/attachments/client/use-attachment-uploads.ts";
import { attachmentUrl } from "~/modules/attachments/client/use-attachment-uploads.ts";
import type { MessageAttachment } from "~/modules/attachments/schema.ts";
import { AttachmentPreviewDialog } from "~/modules/attachments/ui/attachment-preview.tsx";
import { AttachmentChip, AttachmentChipRow } from "~/modules/attachments/ui/attachment-chip.tsx";
import { WorkspaceFileChip } from "~/modules/desktop/ui/workspace-file-chip.tsx";
import { Button } from "~/ui/primitives/button";
import {
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  disclosureChevronMotionClassName,
  disclosureTriggerClassName,
} from "~/ui/disclosure.tsx";
import { cn } from "~/ui/utils";
import { focusRingClassName } from "~/ui/focus-ring.ts";

// Renders GFM footnote references as citation chips linking to their source,
// and hides the footnote list streamdown would otherwise append (the detail
// panel is our sources UI).
// Both hooks into streamdown's output, the `#user-content-fn-N` href shape and
// `data-footnotes` section, are verified against 2.5.0 by render tests;
// re-check on upgrade.
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
      // undefined, since a truthiness check here silently renders the list.
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

export interface DisplayMessage {
  files?: ReadonlyArray<AssistantFile>;
  id: string;
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
  /** Decisions this message is waiting on, by tool-call id. */
  desktopApprovals?: ReadonlyMap<string, DesktopApprovalRequest> | undefined;
  /**
   * The attempt's roots (name + absolute path), so delete lists group by the
   * folder that owns each path. Absent on user bubbles and browser history.
   */
  desktopRoots?: ReadonlyArray<{ name: string; path: string }> | undefined;
  /** Sanitized failure reason stored with the message, when it failed. */
  error?: string | null;
  /**
   * Day heading to draw above this message. Set only on the message that opens
   * a local calendar day, and absent on a message whose date will not parse.
   */
  dayLabel?: string | null;
  /** Durable and live compaction occurrences inside this assistant response. */
  compactionActivities?: CompactionActivity[];
  /** Messages steered into this answer while it ran, drawn where they arrived. */
  steers?: ReadonlyArray<AssistantSteer>;
  /** Local send time for the action row; absent if its date will not parse. */
  time?: MessageTime | null;
  /** Collections the user added with this message, shown beside its files. */
  collectionIds?: ReadonlyArray<string>;
  skills?: ReadonlyArray<{ id: string; name: string }>;
  editedAt?: Date | null;
  /**
   * Sources from earlier messages in the conversation. Citation numbering is
   * conversation-scoped, so a message may cite a source it didn't search for
   * itself; markers resolve against these plus the message's own sources.
   */
  inheritedSources?: ToolSource[];
  /** Files sent with this message, in position order. */
  attachments?: ReadonlyArray<MessageAttachment>;
  /**
   * Files this send copied into the chat's workspace, by basename. The path
   * joins against the machine's current workspace root at click time: the
   * server stores names only, and a browser renders these inert.
   */
  workspaceFiles?: ReadonlyArray<string>;
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
    onResearchEnabledChange?: (enabled: boolean) => void;
    /** The view-level upload state, seeded with the message's own files. */
    attachments: AttachmentUploads;
    /** Seeded with the message's own selections, so `/` and `#` work in an edit. */
    skills?: {
      items: readonly SkillSummary[];
      selectedIds: readonly string[];
      onChange: (ids: string[]) => void;
    };
    context?: ComposerContext;
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

    // Fractional, unlike offsetHeight: an integer end keyframe leaves the row a
    // subpixel off its natural height, and removing the animation snaps it back.
    const height = element.getBoundingClientRect().height;
    if (
      wasEditing.current !== editing &&
      lastHeight.current !== null &&
      lastHeight.current !== height &&
      typeof element.animate === "function" &&
      !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      // The fade lands early and holds: fading to the end kept the row on its
      // own compositing layer, and the shadow repaint when that layer went away
      // read as a flicker. Overflow is not animatable, so the growing side may
      // overlap the row below; clipping would cut the shadow off.
      element.animate(
        [
          { height: `${lastHeight.current}px`, opacity: 0 },
          { opacity: 1, offset: 0.45 },
          { height: `${height}px`, opacity: 1 },
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
  // Edited as plain words with chips, like the composer; saved with the links back.
  const [initial] = useState(() => extractReferences(editState.initialDraft));
  const [draft, setDraft] = useState(initial.text);
  const [references, setReferences] = useState(initial.references);
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
        onSubmit={() => editState.onSave(restoreReferences(draft, references))}
        onCancel={editState.onCancel}
        disabled={editState.saveDisabled}
        controlsDisabled={editState.controlsDisabled}
        modelId={editState.modelId}
        onModelChange={editState.onModelChange}
        searchEnabled={editState.searchEnabled}
        researchEnabled={editState.researchEnabled ?? false}
        onSearchEnabledChange={editState.onSearchEnabledChange}
        {...(editState.onResearchEnabledChange
          ? { onResearchEnabledChange: editState.onResearchEnabledChange }
          : {})}
        attachments={editState.attachments}
        {...(editState.skills ? { skills: editState.skills } : {})}
        {...(editState.context ? { context: editState.context } : {})}
        references={{
          items: references,
          onRemove: (removed) =>
            setReferences((current) => current.filter((reference) => reference !== removed)),
        }}
        placeholder="Edit message…"
        textareaLabel="Edit message"
        submitLabel="Save edit"
      />
    </div>
  );
}

function UserBubble({ message }: { message: DisplayMessage }) {
  const wrapperRef = useEditSwapHeight(message.editState !== undefined);
  // The stored text keeps its links for the model; people see chips and words.
  const { text, references } = extractReferences(message.content);

  return (
    <div ref={wrapperRef} className="w-full">
      {message.editState ? (
        <InlineMessageEditor editState={message.editState} />
      ) : (
        <div className="group/user flex w-full flex-col items-end">
          {references.length > 0 ||
          (message.attachments && message.attachments.length > 0) ||
          (message.workspaceFiles && message.workspaceFiles.length > 0) ||
          (message.collectionIds && message.collectionIds.length > 0) ||
          (message.skills && message.skills.length > 0) ? (
            <AttachmentChipRow className="mb-1.5 max-w-[80%] justify-end">
              {references.map((reference) => (
                <ReferenceChip key={`${reference.kind}:${reference.id}`} reference={reference} />
              ))}
              {message.skills?.map((skill) => (
                <ContextChip
                  key={skill.id}
                  item={{ kind: "skill", id: skill.id, name: skill.name }}
                />
              ))}
              {message.collectionIds?.map((collectionId) => (
                <CollectionChip key={collectionId} collectionId={collectionId} />
              ))}
              {message.attachments?.map((attachment) => (
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
              {message.workspaceFiles?.map((name) => (
                <WorkspaceFileChip key={name} fileName={name} />
              ))}
            </AttachmentChipRow>
          ) : null}
          {/* An attachment-only turn has no text bubble to draw. */}
          {text ? (
            <div className="bg-primary text-primary-foreground max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed">
              {text}
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
            content={text}
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

function AssistantFileAttachment({ file }: { file: AssistantFile }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const url = attachmentUrl(file.attachment.id);
  const { attachment } = file;
  if (attachment.kind !== "image")
    // A document sits where the tool produced it, as the chip a sent message
    // uses; the click opens the same preview the composer's chips open.
    return (
      <AttachmentChipRow className="my-3">
        <AttachmentChip
          item={{ fileName: attachment.fileName, size: attachment.size, kind: attachment.kind }}
          href={url}
          preview={url}
        />
      </AttachmentChipRow>
    );
  return (
    <figure className="my-3 max-w-full space-y-2">
      {state === "loading" && (
        <p role="status" className="text-muted-foreground text-sm">
          Loading image…
        </p>
      )}
      {state === "error" ? (
        <p role="alert" className="text-muted-foreground text-sm">
          This image could not be loaded.
        </p>
      ) : (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Preview ${attachment.fileName}`}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            setPreviewOpen(true);
          }}
        >
          <img
            src={url}
            alt={file.origin ? attachment.fileName : "Generated image"}
            onLoad={() => setState("ready")}
            onError={() => setState("error")}
            className="max-h-144 max-w-full rounded-2xl object-contain"
          />
        </a>
      )}
      <AttachmentPreviewDialog
        target={{ fileName: attachment.fileName, size: attachment.size, kind: "image", url }}
        open={previewOpen}
        onOpenChange={setPreviewOpen}
      />
    </figure>
  );
}

const EMPTY_STEERS: ReadonlyArray<AssistantSteer> = [];

/**
 * A message the person sent into this answer while it ran, drawn where the
 * answer took it in: the text above was written before it, the text below
 * after. Read-only; it goes when the answer is retried or its question edited.
 */
function SteerBubble({ steer }: { steer: AssistantSteer }) {
  return (
    <div className="my-3 flex w-full flex-col items-end">
      {steer.attachments.length > 0 ? (
        <AttachmentChipRow className="mb-1.5 max-w-[80%] justify-end">
          {steer.attachments.map((attachment) => (
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
      {steer.content ? (
        <div className="bg-primary text-primary-foreground max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed">
          {steer.content}
        </div>
      ) : null}
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
    files: message.files ?? [],
    tools: message.toolActivities,
    compactions: message.compactionActivities ?? EMPTY_COMPACTION_ACTIVITIES,
    steers: message.steers ?? EMPTY_STEERS,
  });
  return parts.map((part) => {
    if (part.kind === "file") return <AssistantFileAttachment key={part.key} file={part.file} />;
    if (part.kind === "steer") return <SteerBubble key={part.key} steer={part.steer} />;
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
    if (part.kind === "skill")
      return <SkillActivityBlock key={part.key} activities={part.activities} />;
    if (part.kind === "knowledge") {
      return <KnowledgeActivityBlock key={part.key} activities={part.activities} />;
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
            (activity): activity is ResearchStepActivity =>
              (activity.family === "web" ||
                activity.family === "knowledge" ||
                activity.family === "skill") &&
              !!runId &&
              activity.runId === runId,
          )}
          sourceCount={sources.length}
        />
      );
    }
    // Direct context is shown on the question that added the collection, not
    // as an activity on the answer; its citations still resolve.
    if (part.activity.family === "knowledge" || part.activity.family === "skill") return null;
    if (part.activity.family === "plan")
      return <PlanActivityBlock key={part.key} activity={part.activity} />;
    if (part.activity.family === "agent-draft")
      return <AgentDraftActivityBlock key={part.key} activity={part.activity} />;
    if (part.activity.family === "schedule-draft")
      return <ScheduleDraftActivityBlock key={part.key} activity={part.activity} />;
    if (part.activity.family === "document")
      return <DocumentActivityBlock key={part.key} activity={part.activity} />;
    if (part.activity.family === "custom") {
      return <CustomToolActivityBlock key={part.key} activity={part.activity} />;
    }
    if (part.activity.family === "memory") {
      return <MemoryActivityBlock key={part.key} activity={part.activity} />;
    }
    if (part.activity.family === "desktop") {
      const approval = message.desktopApprovals?.get(part.activity.callId);
      return (
        <DesktopActivityBlock
          key={part.key}
          activity={part.activity}
          roots={message.desktopRoots ?? []}
          {...(approval ? { approval } : {})}
        />
      );
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
  webActivities: ResearchStepActivity[];
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
  const terminalFailure = responseFailureCopy(error);
  if (terminalFailure) return terminalFailure;
  if (error && RATE_LIMIT.test(error)) {
    const delay = retryDelay(error);
    return {
      title: "This model is busy",
      description: delay ? `Try again in ${delay}.` : "Try again in a moment.",
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
  const details = error && !responseFailureCopy(error) ? generationFailureDetails(error) : null;

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
                    focusRingClassName,
                    // oxlint-disable-next-line shadcn/no-restyle -- the details toggle stays secondary to the error above it
                    "w-fit gap-1 rounded-lg text-xs font-medium",
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
            <HugeiconsIcon
              icon={RefreshIcon}
              strokeWidth={2}
              data-icon="inline-start"
              aria-hidden
            />
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
  const toolRunning = message.toolActivities.some((a) => a.status === "running");
  // "Thinking" is the phase before any visible answer text arrives, but not
  // while a tool is running (the tool block carries the progress feedback).
  const reasoningActive =
    streaming && message.content.length === 0 && !message.files?.length && !toolRunning;
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
        !message.files?.length &&
        !showReasoning &&
        !toolRunning &&
        !compacting ? (
          <span className="text-shimmer">Thinking…</span>
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
        {streaming || (message.content.length === 0 && !message.files?.length) ? null : (
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
