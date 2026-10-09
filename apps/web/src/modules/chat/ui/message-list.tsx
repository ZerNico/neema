import { SkillActivityBlock } from "./skill-activity-block.tsx";
import { findTags, tagWords } from "../tags.ts";
import { MessageTagText } from "./message-tag.tsx";
import type { ComposerFieldHandle } from "./chat-textarea.tsx";
import { responseFailureCopy } from "../generation-failure.ts";
import { NO_LOOKUPS, type AssistantFile, type UiLookups } from "../assistant-output.ts";
import {
  Alert02Icon,
  ArrowDown01Icon,
  Comment01Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { readCommentMessage } from "~/modules/documents/comment-message.ts";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  createContext,
  memo,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { LiveText } from "../client/live-text.ts";
import { withLiveText } from "./live-message.ts";
import { NO_INHERITED_SOURCES, type InheritedSources } from "./inherited-sources.ts";
import {
  type CompactionActivity,
  type ResearchToolActivity,
  type StreamState,
  type ToolActivity,
  type ToolSource,
} from "../client/use-message-stream.ts";
import {
  AssistantMarkdown,
  MarkdownReferenceSpan,
  type MarkdownComponents,
} from "./assistant-markdown.tsx";
import { FileReferenceMachine } from "./file-reference-context.ts";
import { AskUserBlock, type QuestionActions } from "./ask-user-block.tsx";
import {
  projectAssistantBody,
  type AssistantSteer,
  type WorkPart,
  type WorkStep,
} from "./assistant-body.ts";
import { WorkingFileActivityBlock } from "./working-file-activity-block.tsx";
import { CitationChip } from "./citation-chip.tsx";
import { CompactionBlock } from "./compaction-block.tsx";
import { ChatInput } from "./chat-input.tsx";
import {
  footnoteIndexes,
  collectSources,
  prepareCitedMarkdown,
  selectAnswerSources,
} from "./citations.ts";
import { ResearchActivityBlock } from "./research-activity-block.tsx";
import { type ResearchStepActivity } from "./research-panel.tsx";
import { useResearchPanel } from "./use-research-panel.tsx";
import { researchPosition } from "./research-panel-id.ts";
import type { SkillSummary } from "~/modules/skills/schema.ts";
import type { ReasoningEffort } from "~/modules/providers/model-config.ts";
import {
  CollectionChip,
  ReferenceChip,
  ContextChip,
  type ComposerContext,
} from "./context-picker.tsx";
import { extractReferences, restoreReferences } from "../references.ts";
import { KnowledgeActivityBlock } from "./knowledge-activity-block.tsx";
import { ActivityFace } from "./activity-face.tsx";
import { activityRowClassName } from "./activity-row.ts";
import { PlanActivityBlock } from "./plan-activity-block.tsx";
import { AgentDraftActivityBlock } from "./agent-draft-activity-block.tsx";
import { ScheduleDraftActivityBlock } from "./schedule-draft-activity-block.tsx";
import { DocumentActivityBlock } from "./document-activity-block.tsx";
import { AttachmentActivityRow } from "./attachment-activity-row.tsx";
import { NotifyActivityRow } from "./notify-activity-row.tsx";
import { MapActivityRow } from "./map-activity-row.tsx";
import { ProjectFileActivityRow } from "./project-file-activity-row.tsx";
import { SaveToProjectActions } from "~/modules/projects/ui/save-to-project.tsx";
import { useWritableChatProject } from "~/modules/projects/ui/writable-chat-project-context.ts";
import { IntegrationActivityBlock } from "~/modules/integrations/ui/integration-activity-block.tsx";
import { CustomToolActivityBlock } from "./custom-tool-activity-block.tsx";
import { MemoryActivityBlock } from "./memory-activity-block.tsx";
import { BrowserActivityBlock } from "./browser-activity-block.tsx";
import { DesktopActivityBlock, type DesktopApprovalRequest } from "./desktop-activity-block.tsx";
import { MessageActions, ResumeMenu } from "./message-actions.tsx";
import { ReasoningBlock } from "./reasoning-block.tsx";
import { WorkGroupBlock } from "./work-group-block.tsx";
import { stepActivities } from "./work-steps.ts";
import { useSourcesPanel } from "./use-sources-panel.tsx";
import type { MessageTime } from "./timestamps.ts";
import { ToolActivityBlock } from "./tool-activity-block.tsx";
import type { AttachmentUploads } from "~/modules/attachments/client/use-attachment-uploads.ts";
import { attachmentUrl } from "~/modules/attachments/client/use-attachment-uploads.ts";
import type { Attachment, MessageAttachment } from "~/modules/attachments/schema.ts";
import {
  AttachmentPreviewDialog,
  filePanelRequest,
} from "~/modules/attachments/ui/attachment-preview.tsx";
import {
  useDetailPanel,
  useDetailPanelAvailable,
  useDetailPanelTabContent,
  useDetailPanelTabIds,
} from "~/ui/detail-panel-context.ts";
import { officePreview } from "~/modules/attachments/ui/office-preview.ts";
import { AttachmentChip, AttachmentChipRow } from "~/modules/attachments/ui/attachment-chip.tsx";
import { WorkspaceFileChip } from "~/modules/desktop/ui/workspace-file-chip.tsx";
import { Button } from "~/ui/primitives/button";
import { Disclosure, DisclosureContent, DisclosureTrigger } from "~/ui/disclosure.tsx";
import {
  disclosureChevronMotionClassName,
  disclosureTriggerClassName,
} from "~/ui/disclosure-classes.ts";
import { cn } from "~/ui/utils";
import { focusRingClassName } from "~/ui/focus-ring.ts";
import { keyUiFences, scanUiFences } from "~/modules/genui/fences.ts";
import { prewarmGenui } from "~/modules/genui/client/prewarm.ts";
import { GenuiMessageContext, type SavedUiState } from "~/modules/genui/ui/context.ts";

const NO_UI_STATES: ReadonlyMap<number, SavedUiState> = new Map();

// The sources change with every streamed token, but the components must not:
// a new component function is a new element type to React, which remounts the
// chip and closes its hover card mid-read. So they are fixed and read the
// current sources from context.
const CitationSources = createContext<ReadonlyMap<number, ToolSource>>(new Map());

// Renders GFM footnote references as citation chips linking to their source,
// and hides the footnote list streamdown would otherwise append (the detail
// panel is our sources UI).
// Both hooks into streamdown's output, the `#user-content-fn-N` href shape and
// `data-footnotes` section, are verified against 2.5.0 by render tests;
// re-check on upgrade.
const citationComponents: MarkdownComponents = {
  span: function CitationLink({ node, children, ...props }) {
    const citationSources = use(CitationSources);
    const href = node?.data && "referenceHref" in node.data ? node.data.referenceHref : undefined;
    const [source, ...more] = footnoteIndexes(typeof href === "string" ? href : undefined).flatMap(
      (index) => {
        const found = citationSources.get(index);
        return found ? [found] : [];
      },
    );
    if (!source) {
      return (
        <MarkdownReferenceSpan {...(node ? { node } : {})} {...props}>
          {children}
        </MarkdownReferenceSpan>
      );
    }
    return <CitationChip source={source} more={more} />;
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
  const byIndex = useMemo(() => new Map(sources.map((s) => [s.index, s])), [sources]);
  const content = useMemo(() => prepareCitedMarkdown(rawContent, sources), [rawContent, sources]);
  return (
    <CitationSources value={byIndex}>
      <AssistantMarkdown
        content={content}
        components={citationComponents}
        hasCitations
        streaming={streaming}
      />
    </CitationSources>
  );
});

export interface DisplayMessage {
  desktopMachineId?: string | null;
  /** Scanned pages the live answer is reading before it can start. */
  reading?: StreamState["reading"];
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
  inheritedSources?: InheritedSources;
  /** Files sent with this message, in position order. */
  attachments?: ReadonlyArray<MessageAttachment>;
  /** The attempt that wrote this answer, which names the attempt in a block's save. */
  generationId?: string | null;
  /** Saved ```ui block state by ordinal. */
  uiStates?: ReadonlyMap<number, SavedUiState>;
  /** In a temporary chat, which leaves nothing behind on the device either. */
  temporary?: boolean;
  /** What the answer's ```ui blocks looked up: images, places, routes. */
  uiLookups?: UiLookups;
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
    reasoningEffort?: ReasoningEffort | null | undefined;
    onReasoningEffortChange?: ((effort: ReasoningEffort | null) => void) | undefined;
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
  /** Continue this failed or stopped last answer from where it ended. */
  onResume?: () => void;
  /** Continue it with a different model. */
  onResumeWith?: (modelId: string) => void;
  /**
   * The stream behind the one live answer. Its text is read by the row, never
   * copied into this object, so a pacing tick re-renders that row alone.
   */
  liveStream?: LiveStream;
}

export interface LiveStream {
  text: LiveText;
  status: StreamState["status"];
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

const staticSubscribe = () => () => {};
const noSnapshot = () => null;

export const MessageBubble = memo(function MessageBubble({
  message: row,
}: {
  message: DisplayMessage;
}) {
  // One component whether live or not: swapping the tree when the stream ends
  // would remount the bubble and drop whatever the reader was typing in it.
  const live = row.liveStream;
  const snapshot = useSyncExternalStore(
    live?.text.subscribe ?? staticSubscribe,
    live?.text.getSnapshot ?? noSnapshot,
    live?.text.getSnapshot ?? noSnapshot,
  );
  const message = live && snapshot ? withLiveText(row, live.status, snapshot) : row;
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
  const textareaRef = useRef<ComposerFieldHandle>(null);

  // Focus without scrolling so the virtualizer, not the browser, owns row
  // position; the caret starts after the words being edited.
  useLayoutEffect(() => {
    textareaRef.current?.focus({ preventScroll: true, atEnd: true });
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
        reasoningEffort={editState.reasoningEffort}
        onReasoningEffortChange={editState.onReasoningEffortChange}
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
  // Skills and collections named in the text show there as tags; a chip up
  // here is only for the ones it does not name (older messages, the agent's).
  const tagged = new Set(findTags(text).map((tag) => `${tag.kind}:${tag.id}`));
  const chipSkills = message.skills?.filter((skill) => !tagged.has(`skill:${skill.id}`));
  const chipCollections = message.collectionIds?.filter((id) => !tagged.has(`collection:${id}`));
  const comment = readCommentMessage(text);

  return (
    <div ref={wrapperRef} className="w-full">
      {message.editState ? (
        <InlineMessageEditor editState={message.editState} />
      ) : (
        <div className="group/user flex w-full flex-col items-end">
          {references.length > 0 ||
          (message.attachments && message.attachments.length > 0) ||
          (message.workspaceFiles && message.workspaceFiles.length > 0) ||
          (chipCollections && chipCollections.length > 0) ||
          (chipSkills && chipSkills.length > 0) ? (
            <AttachmentChipRow className="mb-1.5 max-w-[80%] justify-end">
              {references.map((reference) => (
                <ReferenceChip key={`${reference.kind}:${reference.id}`} reference={reference} />
              ))}
              {chipSkills?.map((skill) => (
                <ContextChip
                  key={skill.id}
                  item={{ kind: "skill", id: skill.id, name: skill.name }}
                />
              ))}
              {chipCollections?.map((collectionId) => (
                <CollectionChip key={collectionId} collectionId={collectionId} />
              ))}
              {message.attachments?.map((attachment) => (
                <StoredAttachmentChip key={attachment.id} attachment={attachment} />
              ))}
              {message.workspaceFiles?.map((name) => (
                <WorkspaceFileChip key={name} fileName={name} />
              ))}
            </AttachmentChipRow>
          ) : null}
          {/* An attachment-only turn has no text bubble to draw. */}
          {comment ? (
            // Sent from a comment in a document: shown as that comment, as it reads there.
            <div className="bg-card text-card-foreground flex max-w-[80%] flex-col gap-1.5 rounded-2xl border px-4 py-3 text-sm">
              <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <HugeiconsIcon icon={Comment01Icon} strokeWidth={2} className="size-3.5" />
                <span className="truncate">Comment on “{comment.quote}”</span>
              </span>
              <span className="whitespace-pre-wrap wrap-anywhere leading-relaxed">
                {comment.body}
              </span>
            </div>
          ) : text ? (
            <div className="bg-primary text-primary-foreground max-w-[80%] whitespace-pre-wrap wrap-anywhere rounded-2xl px-4 py-2.5 text-sm leading-relaxed">
              <MessageTagText text={text} />
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
            content={tagWords(text)}
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

/** A file stored with the chat; in a project chat its preview can save it there. */
function StoredAttachmentChip({
  attachment,
  thumbnail = true,
}: {
  attachment: Attachment;
  thumbnail?: boolean;
}) {
  const url = attachmentUrl(attachment.id);
  const project = useWritableChatProject();
  return (
    <AttachmentChip
      item={{
        fileName: attachment.fileName,
        size: attachment.size,
        kind: attachment.kind,
        ...(thumbnail ? { previewUrl: attachment.kind === "image" ? url : null } : {}),
      }}
      href={url}
      preview={url}
      office={officePreview(attachment, { kind: "attachment", id: attachment.id })}
      {...(project
        ? {
            previewActions: (
              <SaveToProjectActions project={project} attachmentId={attachment.id} url={url} />
            ),
          }
        : {})}
    />
  );
}

// Files this page already opened by itself: the list remounts rows on scroll.
const AUTO_OPENED_FILES = new Set<string>();

const attachmentPanelRequest = (attachment: Attachment) =>
  filePanelRequest({
    fileName: attachment.fileName,
    size: attachment.size,
    kind: attachment.kind,
    url: attachmentUrl(attachment.id),
    office: officePreview(attachment, { kind: "attachment", id: attachment.id }),
  });

/**
 * A document an answer delivers opens beside the chat as it arrives, as
 * ChatGPT's and Claude's do; reloading the chat opens nothing. An image is
 * already in full view. The card also gives a restored tab its body back.
 */
function useDeliveredFilePanel(attachment: Attachment, fresh: boolean) {
  const panel = useDetailPanel();
  const available = useDetailPanelAvailable();
  const request = useMemo(() => attachmentPanelRequest(attachment), [attachment]);
  const { id } = request;
  const open = useDetailPanelTabIds().includes(id);
  useDetailPanelTabContent(id, open ? request : null);
  useEffect(() => {
    if (!fresh || !available || attachment.kind === "image" || AUTO_OPENED_FILES.has(id)) return;
    AUTO_OPENED_FILES.add(id);
    panel.open(request);
  }, [fresh, available, attachment.kind, id, panel, request]);
}

function AssistantFileAttachment({
  file,
  fresh = false,
}: {
  file: AssistantFile;
  fresh?: boolean;
}) {
  useDeliveredFilePanel(file.attachment, fresh);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  // The virtual list remounts rows on scroll; an image already in the cache is
  // shown at once, so only a first network load fades in.
  const [cached, setCached] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  useLayoutEffect(() => {
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth > 0) setCached(true);
  }, []);
  const url = attachmentUrl(file.attachment.id);
  const { attachment } = file;
  if (attachment.kind !== "image")
    // A document sits where the tool produced it, as the chip a sent message
    // uses; the click opens the same preview the composer's chips open.
    return (
      <AttachmentChipRow className="my-3">
        <StoredAttachmentChip attachment={attachment} thumbnail={false} />
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
            ref={imageRef}
            src={url}
            alt={file.origin ? attachment.fileName : "Generated image"}
            onLoad={() => setState("ready")}
            onError={() => setState("error")}
            className={cn(
              "max-h-144 max-w-full rounded-2xl object-contain",
              !cached && "transition-opacity duration-300 motion-reduce:transition-none",
              !cached && state !== "ready" && "opacity-0",
            )}
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
            <StoredAttachmentChip key={attachment.id} attachment={attachment} />
          ))}
        </AttachmentChipRow>
      ) : null}
      {steer.content ? (
        <div className="bg-primary text-primary-foreground max-w-[80%] whitespace-pre-wrap wrap-anywhere rounded-2xl px-4 py-2.5 text-sm leading-relaxed">
          {steer.content}
        </div>
      ) : null}
    </div>
  );
}

type BodyParts = ReturnType<typeof projectAssistantBody>["parts"];
type BodyPart = BodyParts[number];

const AssistantBody = memo(function AssistantBody({
  message,
  parts,
  sources,
  onOpenSources,
  reasoningActive,
}: {
  message: DisplayMessage;
  parts: BodyParts;
  sources: ToolSource[];
  onOpenSources?: () => void;
  reasoningActive: boolean;
}) {
  const streaming = message.status === "streaming";
  const uiFenceStarts = useMemo(
    () => scanUiFences(message.content).map((f) => f.start),
    [message.content],
  );
  const hasUiBlocks = uiFenceStarts.length > 0;
  // A block waits on cached trees, its renderer and QuickJS: start them now, together.
  useEffect(() => {
    if (hasUiBlocks) void prewarmGenui();
  }, [hasUiBlocks]);
  const iso = message.time?.iso;
  const genui = useMemo(
    () => ({
      messageId: message.id,
      createdAt: iso ? Date.parse(iso) || 0 : 0,
      streaming,
      generationId: message.generationId ?? null,
      saved: message.uiStates ?? NO_UI_STATES,
      lookups: message.uiLookups ?? NO_LOOKUPS,
      temporary: message.temporary === true,
    }),
    [
      message.id,
      iso,
      streaming,
      message.generationId,
      message.uiStates,
      message.uiLookups,
      message.temporary,
    ],
  );
  const usedIndexes = useMemo(() => new Set(sources.map((source) => source.index)), [sources]);
  // Working files a publish in this answer delivered, whichever tool made them.
  const publishedFiles: ReadonlySet<string> = useMemo(
    () =>
      new Set(
        message.toolActivities.flatMap((step) =>
          step.family === "tool-file" && step.status === "complete" && step.workingFileId
            ? [step.workingFileId]
            : [],
        ),
      ),
    [message.toolActivities],
  );
  const renderPart = (part: WorkStep | Exclude<BodyPart, WorkPart>) => {
    if (part.kind === "reasoning")
      return (
        <ReasoningBlock key={part.key} reasoning={message.reasoning} active={reasoningActive} />
      );
    if (part.kind === "file")
      return <AssistantFileAttachment key={part.key} file={part.file} fresh={streaming} />;
    if (part.kind === "steer") return <SteerBubble key={part.key} steer={part.steer} />;
    if (part.kind === "text") {
      // Keyed on the raw text, before any citation rewrite changes lengths.
      const content = keyUiFences(
        part.content,
        uiFenceStarts.filter((start) => start < part.start).length,
      );
      return (
        <div key={part.key} className="mb-3 last:mb-0">
          <FileReferenceMachine value={message.desktopMachineId ?? null}>
            {sources.length > 0 ? (
              <CitedAnswer content={content} sources={sources} streaming={part.streaming} />
            ) : (
              <AssistantMarkdown content={content} streaming={part.streaming} />
            )}
          </FileReferenceMachine>
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
    if (part.kind === "browser")
      return (
        <BrowserActivityBlock
          key={part.key}
          activities={part.activities}
          approvals={message.desktopApprovals}
        />
      );
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
    if (part.kind === "working-file")
      return (
        <WorkingFileActivityBlock
          key={part.key}
          part={part}
          state={{
            streaming,
            live: part.newest ?? false,
            published: !!part.workingFileId && publishedFiles.has(part.workingFileId),
            final: part.final ?? true,
          }}
        />
      );
    if (part.activity.family === "research") {
      const runId = part.activity.progress?.runId;
      return (
        <ResearchActivityRow
          key={part.key}
          messageId={message.id}
          position={researchPosition(message.toolActivities, part.activity.callId)}
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
    // as an activity on the answer; its citations still resolve. Tool loads
    // never reach here (`assistant-body.ts` drops them).
    if (
      part.activity.family === "knowledge" ||
      part.activity.family === "skill" ||
      part.activity.family === "tool-load"
    )
      return null;
    if (part.activity.family === "plan")
      return <PlanActivityBlock key={part.key} activity={part.activity} />;
    if (part.activity.family === "agent-draft")
      return <AgentDraftActivityBlock key={part.key} activity={part.activity} />;
    if (part.activity.family === "schedule-draft")
      return <ScheduleDraftActivityBlock key={part.key} activity={part.activity} />;
    if (part.activity.family === "document")
      return <DocumentActivityBlock key={part.key} activity={part.activity} />;
    if (part.activity.family === "project-file")
      return <ProjectFileActivityRow key={part.key} activity={part.activity} />;
    if (part.activity.family === "attachment")
      return <AttachmentActivityRow key={part.key} activity={part.activity} />;
    if (part.activity.family === "notify")
      return <NotifyActivityRow key={part.key} activity={part.activity} />;
    if (part.activity.family === "map")
      return <MapActivityRow key={part.key} activity={part.activity} />;
    if (part.activity.family === "custom") {
      return (
        <CustomToolActivityBlock
          key={part.key}
          activity={part.activity}
          terminal={!streaming}
          published={publishedFiles}
        />
      );
    }
    if (part.activity.family === "integration")
      return <IntegrationActivityBlock key={part.key} activity={part.activity} />;
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
  };
  return (
    <GenuiMessageContext value={genui}>
      {parts.map((part, index) => {
        const live = streaming && index === parts.length - 1;
        if (part.kind !== "work") return renderPart(part);
        // A lone step without calls (reasoning, a compaction) keeps its own row:
        // a work line would only repeat it. Any call, even one, gets the line.
        if (part.steps.length === 1 && stepActivities(part.steps[0]!).length === 0)
          return renderPart(part.steps[0]!);
        return (
          <WorkGroupBlock
            key={part.key}
            part={part}
            live={live}
            approvals={message.desktopApprovals}
            renderStep={(step) => renderPart(step)}
          />
        );
      })}
    </GenuiMessageContext>
  );
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
  position,
  activity,
  webActivities,
  sourceCount,
}: {
  messageId: string;
  /** Its place among the message's research calls, which keys its panel. */
  position: number;
  activity: ResearchToolActivity;
  webActivities: ResearchStepActivity[];
  sourceCount: number;
}) {
  const open = useResearchPanel(messageId, position, activity, webActivities);
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
  resume,
}: {
  error: string | null | undefined;
  onRetry: (() => void) | undefined;
  retryDisabled: boolean;
  resume: ReactNode;
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
        {resume || onRetry ? (
          <div className="ml-11 flex gap-2 self-start sm:ml-0">
            {resume}
            {onRetry ? (
              <Button size="sm" variant="outline" onClick={onRetry} disabled={retryDisabled}>
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
  const compactions = message.compactionActivities ?? EMPTY_COMPACTION_ACTIVITIES;
  const compacting = compactions.some((activity) => activity.status === "running");
  const steers = message.steers ?? EMPTY_STEERS;
  // Reasoning leads the answer's first run of work, inside its group.
  const showReasoning = message.reasoningSeen || message.reasoning.length > 0;
  // Projected once here: the body renders it and the Thinking line reads it.
  const parts = useMemo(
    () =>
      projectAssistantBody({
        content: message.content,
        rawTextLength: message.rawTextLength ?? message.content.length,
        streaming,
        files: message.files ?? [],
        tools: message.toolActivities,
        compactions,
        steers,
        reasoning: showReasoning,
      }).parts,
    [
      message.content,
      message.rawTextLength,
      streaming,
      message.files,
      message.toolActivities,
      compactions,
      steers,
      showReasoning,
    ],
  );
  // The chat view wires resume only on the last answer.
  const resume =
    message.onResume && message.onResumeWith ? (
      <ResumeMenu
        onResume={message.onResume}
        onResumeWith={message.onResumeWith}
        modelId={message.retryModelId}
        disabled={message.retryDisabled ?? false}
      />
    ) : null;

  // Search hits remain in activity; the answer lists cited or extracted evidence.
  const sources = useMemo(
    () =>
      selectAnswerSources(
        message.content,
        collectSources(message.toolActivities),
        message.inheritedSources ?? NO_INHERITED_SOURCES,
      ),
    [message.content, message.inheritedSources, message.toolActivities],
  );

  return (
    <div className="flex w-full justify-start">
      <div className="text-foreground w-full max-w-full text-sm leading-relaxed">
        {sources.length > 0 && (!streaming || message.content.length > 0) ? (
          <AssistantSourcePanel messageId={message.id} sources={sources} bind={bindSourcePanel} />
        ) : null}
        <AssistantBody
          message={message}
          parts={parts}
          sources={sources}
          reasoningActive={reasoningActive}
          {...(sources.length > 0 ? { onOpenSources: openSources } : {})}
        />
        {streaming &&
        message.content.length === 0 &&
        !message.files?.length &&
        !showReasoning &&
        !toolRunning &&
        !compacting &&
        // A live work line already says it is working between its steps.
        parts.at(-1)?.kind !== "work" ? (
          <div className={cn(activityRowClassName, "mb-2")}>
            {/* The label holds still while pages are read; only the count after it rolls. */}
            <ActivityFace
              label={message.reading ? "Reading scanned pages" : "Thinking"}
              detail={
                message.reading ? `${message.reading.read} of ${message.reading.total}` : null
              }
              status="running"
            />
          </div>
        ) : null}
        {message.status === "error" ? (
          <GenerationFailure
            error={message.error}
            onRetry={message.onRetry}
            retryDisabled={message.retryDisabled ?? false}
            resume={resume}
          />
        ) : message.status === "aborted" ? (
          <div className="mt-2 flex items-center gap-3">
            <p className="text-muted-foreground text-xs">Stopped.</p>
            {resume}
          </div>
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
