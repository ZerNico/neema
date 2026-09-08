import {
  ArrowUp02Icon,
  Attachment01Icon,
  GlobalSearchIcon,
  PlusSignIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { forwardRef, useEffect, useId, useRef, useState } from "react";
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
  ContextMenuItems,
  type ContextPickerKind,
  type ComposerContext,
} from "./context-picker.tsx";
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
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Kbd } from "~/ui/primitives/kbd";
import { Spinner } from "~/ui/primitives/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { cn } from "~/ui/utils";
import * as m from "motion/react-m";
import { MotionSwap, useAppReducedMotion } from "~/ui/motion.tsx";
import { Disclosure, DisclosureContent } from "~/ui/disclosure.tsx";

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
    /** Owner-held upload state; research remains available without uploads. */
    attachments?: AttachmentUploads | undefined;
    /** Agent and collections for the next turn; absent hides the controls (edits). */
    context?: ComposerContext | undefined;
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
    attachments,
    context,
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
  const reduced = useAppReducedMotion();
  const action = onStop ? "stop" : attachments?.queued ? "upload" : "send";
  const actionLabel = onStop
    ? "Stop generating"
    : attachments?.queued
      ? "Sending after uploads finish"
      : submitLabel;
  const menuLabel = onResearchEnabledChange || context ? "Add files or tools" : "Add attachment";
  // A context row closes the menu first and opens its popup once the menu is
  // gone, anchored to the same "+" button: two overlays returning focus to
  // each other is what a submenu would have avoided and this avoids too.
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [pendingPicker, setPendingPicker] = useState<ContextPickerKind | null>(null);
  const [picker, setPicker] = useState<ContextPickerKind | null>(null);
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
  const searchAvailable =
    (searchAvailability?.enabled ?? false) && (selectedModel?.capabilities.tools ?? false);

  const researchUnavailableReason = !selectedModel?.capabilities.tools
    ? "Choose a model that supports tools."
    : !researchAvailability
      ? "Checking research availability…"
      : !researchAvailability.configured || !researchAvailability.enabled
        ? "Web search and page reading must both be enabled."
        : null;

  useEffect(() => {
    if (!researchEnabled && searchEnabled && selectedModel && !selectedModel.capabilities.tools) {
      onSearchEnabledChange(false);
    }
  }, [researchEnabled, searchEnabled, selectedModel, onSearchEnabledChange]);

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
      {(attachments && items.length > 0) ||
      (context &&
        ((context.selection.agent && !context.agentLocked) ||
          context.selection.collectionIds.length > 0)) ? (
        <AttachmentChipRow className="px-3 pt-3">
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
        value={value}
        onValueChange={onValueChange}
        onSubmit={submit}
        onCancel={onCancel}
        placeholder={noModels ? "No models configured — ask an admin" : placeholder}
        {...(textareaLabel ? { ariaLabel: textareaLabel } : {})}
        autoFocus={autoFocus}
        disabled={noModels || textareaDisabled}
      />
      <div className="flex items-center gap-1 p-2 pt-0">
        {attachments ? (
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ATTACHMENT_ACCEPT}
            className="hidden"
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
                        controlsDisabled ||
                        (!onResearchEnabledChange &&
                          !context &&
                          (!attachments || attachments.isFull))
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
          <DropdownMenuContent
            align="start"
            className={cn((onResearchEnabledChange || context) && "w-64")}
          >
            <DropdownMenuItem onClick={pickFiles} disabled={!attachments || attachments.isFull}>
              <HugeiconsIcon icon={Attachment01Icon} strokeWidth={2} />
              Attach files
            </DropdownMenuItem>
            {onResearchEnabledChange ? (
              <>
                <DropdownMenuCheckboxItem
                  checked={researchEnabled}
                  onCheckedChange={onResearchEnabledChange}
                  disabled={
                    controlsDisabled ||
                    attachments?.queued ||
                    (!researchEnabled && researchUnavailableReason !== null)
                  }
                  aria-label="Deep research"
                  aria-describedby={researchHintId}
                >
                  <HugeiconsIcon icon={GlobalSearchIcon} strokeWidth={2} />
                  Deep research
                </DropdownMenuCheckboxItem>
              </>
            ) : null}
            {context ? (
              <ContextMenuItems
                selection={context.selection}
                agentLocked={context.agentLocked}
                onPick={setPendingPicker}
                disabled={controlsDisabled}
              />
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
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
        {researchEnabled || searchAvailable ? (
          <Button
            size="sm"
            variant={researchEnabled || searchEnabled ? "default" : "ghost"}
            aria-label={researchEnabled ? "Deep research" : "Search the web"}
            aria-pressed={researchEnabled || searchEnabled}
            onClick={() =>
              researchEnabled
                ? onResearchEnabledChange?.(false)
                : onSearchEnabledChange(!searchEnabled)
            }
            disabled={
              controlsDisabled ||
              (researchEnabled && (!!attachments?.queued || !onResearchEnabledChange))
            }
            className={cn(
              "min-w-0 shrink-0",
              !researchEnabled && !searchEnabled && "text-muted-foreground",
            )}
          >
            <HugeiconsIcon icon={GlobalSearchIcon} strokeWidth={2} data-icon="inline-start" />
            <MotionSwap value={researchEnabled ? "research" : "search"}>
              {researchEnabled ? (
                <span>
                  <span className="max-[420px]:sr-only">Deep </span>research
                </span>
              ) : (
                <span className="max-[420px]:sr-only">Search</span>
              )}
            </MotionSwap>
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
      <Disclosure open={researchEnabled && !!researchUnavailableReason}>
        <DisclosureContent>
          <p role="status" className="text-muted-foreground px-4 pb-3 text-xs">
            {researchUnavailableReason}
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
