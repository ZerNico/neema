import type { SkillSummary } from "~/modules/skills/schema.ts";
import { SkillPicker } from "~/modules/skills/ui/skill-picker.tsx";
import {
  ArrowUp02Icon,
  Attachment01Icon,
  Book02Icon,
  Folder01Icon,
  GlobalSearchIcon,
  PlusSignIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { forwardRef, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  chatModelsQuery,
  researchAvailabilityQuery,
  webSearchAvailabilityQuery,
} from "../client/queries.ts";
import { resolveChatModel } from "../client/selected-model.ts";
import { CHAT_INPUT_SHELL_CLASS, ChatTextarea } from "./chat-textarea.tsx";
import { ModelPicker } from "./model-picker.tsx";
import {
  AgentBar,
  AgentPicker,
  CollectionPicker,
  ContextChips,
  ContextChip,
  ContextMenuItems,
  MAX_SELECTED_COLLECTIONS,
  collectionStatus,
  type ContextPickerKind,
  type ComposerContext,
} from "./context-picker.tsx";
import { knowledgeCollectionsQuery } from "~/modules/knowledge/client/queries.ts";
import { ATTACHMENT_ACCEPT } from "~/modules/attachments/constants.ts";
import { documentParsingAvailabilityQuery } from "~/modules/attachments/client/queries.ts";
import {
  type AttachmentUpload,
  type AttachmentUploads,
  attachmentUrl,
  createPastedTextFile,
  shouldPasteAsFile,
} from "~/modules/attachments/client/use-attachment-uploads.ts";
import { AttachmentChip, AttachmentChipRow } from "~/modules/attachments/ui/attachment-chip.tsx";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Kbd } from "~/ui/primitives/kbd";
import { Spinner } from "~/ui/primitives/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { cn } from "~/ui/utils";
import * as m from "motion/react-m";
import { MotionSwap, useAppReducedMotion } from "~/ui/motion.tsx";
import { Disclosure, DisclosureContent } from "~/ui/disclosure.tsx";
import { ToggleGroup, ToggleGroupItem } from "~/ui/primitives/toggle-group";
import type { ConversationMode } from "../schema.ts";

export const ChatInput = forwardRef<
  HTMLTextAreaElement,
  {
    value: string;
    onValueChange: (value: string) => void;
    onSubmit: () => void;
    onCancel?: (() => void) | undefined;
    /** Replaces the send button while a response is generating. */
    onStop?: (() => void) | undefined;
    disabled: boolean;
    textareaDisabled?: boolean;
    controlsDisabled?: boolean;
    modelId: string | null;
    onModelChange: (modelId: string, source?: "default") => void;
    searchEnabled: boolean;
    onSearchEnabledChange: (enabled: boolean) => void;
    researchEnabled?: boolean;
    onResearchEnabledChange?: (enabled: boolean) => void;
    /**
     * Chat or Work, offered only where Work can be honoured: a new chat inside
     * the desktop app. Absent hides the toggle; an existing chat's mode is
     * fixed at creation and shown by the folder strip instead.
     */
    mode?: { value: ConversationMode; onChange: (mode: ConversationMode) => void } | undefined;
    /** Why sending is blocked right now, when it is. Shown under the row. */
    blockedReason?: string | null | undefined;
    /** Owner-held upload state; research remains available without uploads. */
    attachments?: AttachmentUploads | undefined;
    /** Agent and collections for the next turn; absent hides the controls (edits). */
    context?: ComposerContext | undefined;
    skills?:
      | {
          items: readonly SkillSummary[];
          selectedIds: readonly string[];
          onChange: (ids: string[]) => void;
        }
      | undefined;
    placeholder?: string;
    textareaLabel?: string;
    autoFocus?: boolean;
    submitLabel?: string;
    className?: string;
  }
>(function ChatInput(
  {
    value,
    onValueChange,
    onSubmit,
    onCancel,
    onStop,
    disabled,
    textareaDisabled = disabled,
    controlsDisabled = disabled,
    modelId,
    onModelChange,
    searchEnabled,
    onSearchEnabledChange,
    researchEnabled = false,
    onResearchEnabledChange,
    mode,
    blockedReason = null,
    attachments,
    context,
    skills,
    placeholder = "Message…",
    textareaLabel,
    autoFocus = false,
    submitLabel = "Send",
    className,
  },
  textareaRef,
) {
  const { data: models } = useSuspenseQuery(chatModelsQuery);
  const { data: searchAvailability } = useQuery(webSearchAvailabilityQuery);
  const { data: researchAvailability } = useQuery({
    ...researchAvailabilityQuery,
    enabled: onResearchEnabledChange !== undefined || researchEnabled,
  });
  const researchHintId = useId();
  const modeDisabled = controlsDisabled || !!attachments?.queued || !onResearchEnabledChange;
  const reduced = useAppReducedMotion();
  const action = onStop ? "stop" : attachments?.queued ? "upload" : "send";
  const actionLabel = onStop
    ? "Stop generating"
    : attachments?.queued
      ? "Sending after uploads finish"
      : submitLabel;
  // Everything the "+" menu can offer besides attaching files. Three things key
  // off this — the trigger's label, whether it is enabled at all, and the menu
  // width — and they drifted apart when Skills was added to the menu without
  // being added to any of them, so they read it from one place now.
  const hasTools = !!context || !!skills || !!onResearchEnabledChange || researchEnabled;
  const menuLabel = hasTools ? "Add files or tools" : "Add attachment";
  // "#" offers the same collections the Knowledge popup does, minus the ones
  // already on this message and the agent's own — those are not the user's to
  // add or remove. Selecting one commits immediately, so it passes the full
  // list plus the single addition, exactly as the popup's Add button does.
  const knowledge = useQuery({ ...knowledgeCollectionsQuery, enabled: !!context });
  const mentionableCollections = useMemo(() => {
    if (!context || controlsDisabled) return undefined;
    const selected = new Set(context.selection.collectionIds);
    if (selected.size >= MAX_SELECTED_COLLECTIONS) return undefined;
    return {
      items: (knowledge.data ?? [])
        .filter(
          (collection) =>
            !selected.has(collection.id) && !context.agentCollectionIds.has(collection.id),
        )
        .map((collection) => ({
          id: collection.id,
          label: collection.name,
          description: collection.description || collectionStatus(collection),
        })),
      onSelect: (id: string) =>
        context.onCollectionsChange([...context.selection.collectionIds, id], [id]),
    };
  }, [context, controlsDisabled, knowledge.data]);
  // A context row closes the menu first and opens its popup once the menu is
  // gone, anchored to the same "+" button: two overlays returning focus to
  // each other is what a submenu would have avoided and this avoids too.
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [pendingPicker, setPendingPicker] = useState<ContextPickerKind | "skills" | null>(null);
  const [picker, setPicker] = useState<ContextPickerKind | "skills" | null>(null);
  const { data: parsingAvailability } = useQuery({
    ...documentParsingAvailabilityQuery,
    enabled: attachments !== undefined,
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  // dragenter/dragleave fire for every child; a depth counter keeps the
  // highlight from flickering as the pointer crosses the textarea.
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const noModels = models.length === 0;
  const selectedModel = resolveChatModel(models, modelId);

  useEffect(() => {
    if (selectedModel && selectedModel.id !== modelId) onModelChange(selectedModel.id, "default");
  }, [modelId, onModelChange, selectedModel]);
  // Tools never depend on which model is selected: the gateway polyfills
  // prompt-based calling for models without native support. Only an empty
  // model list hides the toggle, since nothing could be sent anyway.
  const searchAvailable = (searchAvailability?.enabled ?? false) && selectedModel !== undefined;

  const researchUnavailableReason = !researchAvailability
    ? "Checking research availability…"
    : !researchAvailability.configured || !researchAvailability.enabled
      ? "Web search and page reading must both be enabled."
      : null;

  // Parsing lets a PDF through on a model without native file input; while the
  // query is still loading we say nothing rather than flash a wrong warning.
  const parsingUsable = parsingAvailability
    ? parsingAvailability.configured && parsingAvailability.enabled
    : true;

  const warningFor = (item: AttachmentUpload): string | null => {
    if (item.status === "error") return null;
    if (item.kind === "image" && selectedModel && !selectedModel.capabilities.vision) {
      return `${selectedModel.displayName} cannot read images — pick another model or remove this file.`;
    }
    if (
      item.kind === "pdf" &&
      selectedModel &&
      !selectedModel.capabilities.files &&
      !parsingUsable
    ) {
      return `${selectedModel.displayName} cannot read PDFs and document parsing is disabled — ask an admin to enable it or pick another model.`;
    }
    return null;
  };

  // Stored chips preview from the authenticated route; an image still in
  // flight previews from its local object URL.
  const previewFor = (item: AttachmentUpload): string | null => {
    if (item.status === "complete" && item.attachment) return attachmentUrl(item.attachment.id);
    if (item.kind === "image") return item.previewUrl;
    return null;
  };

  const items = attachments?.items ?? [];
  const blocked =
    items.some((item) => item.status === "error") ||
    items.some((item) => warningFor(item) !== null);
  const usable = items.filter((item) => item.status !== "error").length;
  const canSubmit =
    !disabled &&
    !!selectedModel &&
    selectedModel.id === modelId &&
    !blocked &&
    !(researchEnabled && researchUnavailableReason) &&
    !blockedReason &&
    !attachments?.queued &&
    (value.trim() !== "" || usable > 0);

  const submit = () => {
    if (canSubmit) onSubmit();
  };

  const pickFiles = () => fileInputRef.current?.click();

  const acceptDrop = (event: React.DragEvent) =>
    attachments !== undefined && !controlsDisabled && event.dataTransfer.types.includes("Files");

  return (
    <div
      className={cn("relative", CHAT_INPUT_SHELL_CLASS, dragging && "border-ring/60", className)}
      onDragEnter={(event) => {
        if (!acceptDrop(event)) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (!acceptDrop(event)) return;
        event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (!acceptDrop(event)) return;
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={(event) => {
        if (!acceptDrop(event)) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        attachments?.addFiles(event.dataTransfer.files);
      }}
      onPaste={(event) => {
        if (!attachments || controlsDisabled) return;
        const files = Array.from(event.clipboardData.files);
        if (files.length > 0) {
          event.preventDefault();
          attachments.addFiles(files);
          return;
        }
        // A pasted wall of text reads far better as an attachment than as a
        // draft nobody can scroll past.
        const text = event.clipboardData.getData("text/plain");
        if (text && shouldPasteAsFile(text)) {
          event.preventDefault();
          attachments.addFiles([createPastedTextFile(text)]);
        }
      }}
    >
      {context?.agentLocked && context.selection.agent ? (
        <AgentBar agent={context.selection.agent} />
      ) : null}
      {(context?.agentSkillIds && context.agentSkillIds.size > 0) ||
      (skills && skills.selectedIds.length > 0) ||
      (attachments && items.length > 0) ||
      (context &&
        ((context.selection.agent && !context.agentLocked) ||
          context.selection.collectionIds.length > 0)) ? (
        <AttachmentChipRow className="px-3 pt-3">
          {[...(context?.agentSkillIds ?? [])]
            .filter((id) => !skills?.selectedIds.includes(id))
            .map((id) => (
              <ContextChip
                key={`agent-skill:${id}`}
                item={{
                  kind: "skill",
                  id,
                  name: skills?.items.find((skill) => skill.id === id)?.name ?? null,
                  note: "From agent",
                }}
              />
            ))}
          {skills?.selectedIds.map((id) => (
            <ContextChip
              key={`skill:${id}`}
              item={{
                kind: "skill",
                id,
                name: skills.items.find((skill) => skill.id === id)?.name ?? null,
                note: "Skill",
              }}
              onRemove={
                controlsDisabled
                  ? undefined
                  : () => skills.onChange(skills.selectedIds.filter((selected) => selected !== id))
              }
            />
          ))}
          {/* Context first: it frames the files that follow. */}
          {context ? (
            <ContextChips
              selection={context.selection}
              agentCollectionIds={context.agentCollectionIds}
              agentLocked={context.agentLocked}
              onAgentChange={context.onAgentChange}
              onCollectionsChange={context.onCollectionsChange}
              disabled={controlsDisabled}
            />
          ) : null}
          {attachments
            ? items.map((item) => (
                <AttachmentChip
                  key={item.localId}
                  item={item}
                  warning={warningFor(item)}
                  onRemove={controlsDisabled ? undefined : () => attachments.remove(item.localId)}
                  preview={previewFor(item)}
                />
              ))
            : null}
        </AttachmentChipRow>
      ) : null}
      {attachments?.notice ? (
        <p className="text-muted-foreground px-4 pt-2 text-xs">{attachments.notice}</p>
      ) : null}

      <ChatTextarea
        ref={textareaRef}
        skills={
          skills && !controlsDisabled
            ? {
                items: skills.items
                  .filter(
                    (item) =>
                      !skills.selectedIds.includes(item.id) && skills.selectedIds.length < 5,
                  )
                  .map((item) => ({
                    id: item.id,
                    label: item.name,
                    ...(item.ownerName ? { meta: item.ownerName } : {}),
                    description: item.description,
                  })),
                onSelect: (id) => skills.onChange([...new Set([...skills.selectedIds, id])]),
              }
            : undefined
        }
        collections={mentionableCollections}
        value={value}
        onValueChange={onValueChange}
        onSubmit={submit}
        onCancel={onCancel}
        placeholder={noModels ? "No models configured — ask an admin" : placeholder}
        {...(textareaLabel ? { ariaLabel: textareaLabel } : {})}
        autoFocus={autoFocus}
        disabled={noModels || textareaDisabled}
      />
      {/* The textarea's own bottom padding is inside its scroll box, so the gap
          above the controls lives here: it stays constant once the text scrolls. */}
      <div className="flex flex-wrap items-center gap-1 p-2 pt-2">
        {attachments ? (
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ATTACHMENT_ACCEPT}
            className="sr-only"
            aria-label="Attach files"
            // Selecting the same file twice in a row must re-fire `change`.
            onChange={(event) => {
              attachments.addFiles(event.target.files ?? []);
              event.target.value = "";
            }}
          />
        ) : null}
        <DropdownMenu
          onOpenChangeComplete={(open) => {
            if (open || pendingPicker === null) return;
            setPicker(pendingPicker);
            setPendingPicker(null);
          }}
        >
          <Tooltip>
            <DropdownMenuTrigger
              render={
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={menuLabel}
                      ref={setMenuAnchor}
                      disabled={
                        controlsDisabled || (!hasTools && (!attachments || attachments.isFull))
                      }
                      className="text-muted-foreground"
                    />
                  }
                />
              }
            >
              <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
            </DropdownMenuTrigger>
            <TooltipContent>{menuLabel}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" className={cn(hasTools && "w-64")}>
            <DropdownMenuItem onClick={pickFiles} disabled={!attachments || attachments.isFull}>
              <HugeiconsIcon icon={Attachment01Icon} strokeWidth={2} />
              Attach files
            </DropdownMenuItem>
            {context ? (
              <ContextMenuItems
                selection={context.selection}
                agentLocked={context.agentLocked}
                onPick={setPendingPicker}
                disabled={controlsDisabled}
              />
            ) : null}
            {skills ? (
              <DropdownMenuItem
                disabled={controlsDisabled}
                onClick={() => setPendingPicker("skills")}
              >
                <HugeiconsIcon icon={Book02Icon} strokeWidth={2} />
                Skills
                {skills.selectedIds.length > 0 ? (
                  <span className="text-muted-foreground ml-auto pl-2 text-xs tabular-nums">
                    {skills.selectedIds.length}
                  </span>
                ) : null}
              </DropdownMenuItem>
            ) : null}
            {onResearchEnabledChange || researchEnabled ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={researchEnabled}
                  onCheckedChange={(checked) => onResearchEnabledChange?.(checked)}
                  disabled={
                    modeDisabled || (!researchEnabled && researchUnavailableReason !== null)
                  }
                  {...(researchUnavailableReason ? { "aria-describedby": researchHintId } : {})}
                >
                  <HugeiconsIcon icon={GlobalSearchIcon} strokeWidth={2} />
                  Deep research
                </DropdownMenuCheckboxItem>
                {researchUnavailableReason ? (
                  <p id={researchHintId} className="text-muted-foreground px-2 pt-1 pb-1.5 text-xs">
                    {researchUnavailableReason}
                  </p>
                ) : null}
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        {skills ? (
          <SkillPicker
            items={skills.items}
            selectedIds={skills.selectedIds}
            onChange={skills.onChange}
            open={picker === "skills"}
            onOpenChange={(open) => setPicker(open ? "skills" : null)}
            anchor={menuAnchor}
          />
        ) : null}
        {context && !context.agentLocked ? (
          <AgentPicker
            selection={context.selection}
            onAgentChange={context.onAgentChange}
            open={picker === "agent"}
            onOpenChange={(open) => setPicker(open ? "agent" : null)}
            anchor={menuAnchor}
          />
        ) : null}
        {context ? (
          <CollectionPicker
            selection={context.selection}
            agentCollectionIds={context.agentCollectionIds}
            onCollectionsChange={context.onCollectionsChange}
            open={picker === "collections"}
            onOpenChange={(open) => setPicker(open ? "collections" : null)}
            anchor={menuAnchor}
          />
        ) : null}
        {mode ? (
          <ToggleGroup
            value={[mode.value]}
            onValueChange={(values) => {
              const next = values[0];
              if (next === "chat" || next === "work") mode.onChange(next);
            }}
            variant="outline"
            size="sm"
            spacing={0}
            disabled={controlsDisabled}
            aria-label="Chat mode"
            className="shrink-0"
          >
            <ToggleGroupItem value="chat" aria-label="Chat">
              Chat
            </ToggleGroupItem>
            <ToggleGroupItem value="work" aria-label="Work with a folder">
              <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} data-icon="inline-start" />
              Work
            </ToggleGroupItem>
          </ToggleGroup>
        ) : null}
        {researchEnabled ? (
          // The only control the row still needs while research is on: the
          // choice itself lives in the menu, this just leaves it again.
          <Button
            size="sm"
            variant="default"
            aria-label="Deep research"
            aria-pressed
            disabled={modeDisabled}
            onClick={() => onResearchEnabledChange?.(false)}
            className="shrink-0"
          >
            <HugeiconsIcon icon={GlobalSearchIcon} strokeWidth={2} data-icon="inline-start" />
            <span>
              <span className="max-[420px]:sr-only">Deep </span>research
            </span>
          </Button>
        ) : null}
        {!researchEnabled && searchAvailable ? (
          <Button
            size="sm"
            variant={searchEnabled ? "default" : "ghost"}
            aria-label="Search the web"
            aria-pressed={searchEnabled}
            onClick={() => onSearchEnabledChange(!searchEnabled)}
            disabled={controlsDisabled}
            className={cn("shrink-0", !searchEnabled && "text-muted-foreground")}
          >
            <HugeiconsIcon icon={GlobalSearchIcon} strokeWidth={2} data-icon="inline-start" />
            <span className="max-[420px]:sr-only">Search</span>
          </Button>
        ) : null}
        <ModelPicker
          models={models}
          value={selectedModel?.id ?? null}
          onChange={onModelChange}
          disabled={noModels || controlsDisabled}
          trigger={
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground hover:bg-accent min-w-0 max-w-52 gap-1.5"
            />
          }
        >
          <span className="truncate text-sm">{selectedModel?.displayName ?? "Select model"}</span>
        </ModelPicker>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {onCancel ? (
            <Button size="sm" variant="ghost" onClick={onCancel} disabled={disabled}>
              Cancel
            </Button>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  onClick={onStop ?? submit}
                  // Stop is available precisely while sending is disabled.
                  disabled={!onStop && !canSubmit}
                  aria-label={actionLabel}
                  aria-busy={(!onStop && attachments?.queued) || undefined}
                />
              }
            >
              <MotionSwap value={action} kind="icon" className="size-4">
                {onStop ? (
                  <HugeiconsIcon icon={StopIcon} strokeWidth={2} className="size-4" aria-hidden />
                ) : attachments?.queued ? (
                  <Spinner aria-hidden className="size-4 motion-reduce:animate-none" />
                ) : (
                  <HugeiconsIcon
                    icon={ArrowUp02Icon}
                    strokeWidth={2}
                    className="size-4"
                    aria-hidden
                  />
                )}
              </MotionSwap>
            </TooltipTrigger>
            <TooltipContent>
              {actionLabel}
              {!onStop ? <Kbd>Enter</Kbd> : null}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      <Disclosure open={(researchEnabled && !!researchUnavailableReason) || !!blockedReason}>
        <DisclosureContent>
          <p role="status" className="text-muted-foreground px-4 pb-3 text-xs">
            {blockedReason ?? researchUnavailableReason}
          </p>
        </DisclosureContent>
      </Disclosure>
      {/* Never intercept dragleave/drop; only opacity changes, not hit testing. */}
      <m.div
        aria-hidden={!dragging}
        inert
        initial={false}
        animate={{ opacity: dragging ? 1 : 0 }}
        transition={{ duration: reduced ? 0 : 0.12 }}
        className="border-ring/70 bg-background/85 pointer-events-none absolute inset-1 z-10 grid place-items-center rounded-[calc(1.375rem-0.25rem)] border-2 border-dashed backdrop-blur-[2px]"
      >
        <span className="text-foreground flex items-center gap-2 text-sm font-medium">
          <HugeiconsIcon icon={Attachment01Icon} strokeWidth={2} className="size-4" />
          Drop files to attach
        </span>
      </m.div>
    </div>
  );
});
