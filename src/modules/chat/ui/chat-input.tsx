import {
  ArrowDown01Icon,
  ArrowUp02Icon,
  Attachment01Icon,
  GlobalSearchIcon,
  Loading03Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { forwardRef, useEffect, useRef, useState } from "react";
import { chatModelsQuery, webSearchAvailabilityQuery } from "../client/queries.ts";
import { CHAT_INPUT_SHELL_CLASS, ChatTextarea } from "./chat-textarea.tsx";
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
import { CapabilityIcons, ContextBadge } from "~/modules/providers/ui/capability-icons.tsx";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger } from "~/ui/primitives/select";
import { cn } from "~/ui/utils";

export const ChatInput = forwardRef<
  HTMLTextAreaElement,
  {
    value: string;
    onValueChange: (value: string) => void;
    onSubmit: () => void;
    onCancel?: (() => void) | undefined;
    disabled: boolean;
    textareaDisabled?: boolean;
    controlsDisabled?: boolean;
    modelId: string | null;
    onModelChange: (modelId: string) => void;
    searchEnabled: boolean;
    onSearchEnabledChange: (enabled: boolean) => void;
    /** Owner-held upload state; omitted renders the plus button disabled. */
    attachments?: AttachmentUploads | undefined;
    placeholder?: string;
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
    disabled,
    textareaDisabled = disabled,
    controlsDisabled = disabled,
    modelId,
    onModelChange,
    searchEnabled,
    onSearchEnabledChange,
    attachments,
    placeholder = "Message…",
    autoFocus = false,
    submitLabel = "Send",
    className,
  },
  textareaRef,
) {
  const { data: models } = useSuspenseQuery(chatModelsQuery);
  const { data: searchAvailability } = useQuery(webSearchAvailabilityQuery);
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
  const selectedModel = models.find((model) => model.id === modelId);

  useEffect(() => {
    if ((!modelId || !selectedModel) && models[0]) onModelChange(models[0].id);
  }, [modelId, models, onModelChange, selectedModel]);
  const searchAvailable =
    (searchAvailability?.enabled ?? false) && (selectedModel?.capabilities.tools ?? false);

  useEffect(() => {
    if (searchEnabled && selectedModel && !selectedModel.capabilities.tools) {
      onSearchEnabledChange(false);
    }
  }, [searchEnabled, selectedModel, onSearchEnabledChange]);

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
    !blocked &&
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
      className={cn(
        "relative",
        CHAT_INPUT_SHELL_CLASS,
        dragging ? "border-ring/60" : "",
        className,
      )}
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
      {attachments && items.length > 0 ? (
        <AttachmentChipRow className="px-3 pt-3">
          {items.map((item) => (
            <AttachmentChip
              key={item.localId}
              item={item}
              warning={warningFor(item)}
              onRemove={controlsDisabled ? undefined : () => attachments.remove(item.localId)}
              preview={previewFor(item)}
            />
          ))}
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
        autoFocus={autoFocus}
        disabled={noModels || textareaDisabled}
      />
      <div className="flex items-center gap-1 p-2 pt-0">
        {attachments ? (
          <>
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
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Add attachment"
                    disabled={controlsDisabled || attachments.isFull}
                    className="text-muted-foreground size-8 rounded-full"
                  />
                }
              >
                <HugeiconsIcon icon={PlusSignIcon} className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={pickFiles}>
                  <HugeiconsIcon icon={Attachment01Icon} className="size-4" />
                  Attach files
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : (
          <Button
            size="icon"
            variant="ghost"
            aria-label="Add attachment"
            disabled
            className="text-muted-foreground size-8 rounded-full"
          >
            <HugeiconsIcon icon={PlusSignIcon} className="size-4" />
          </Button>
        )}
        {searchAvailable ? (
          <Button
            size="sm"
            variant="ghost"
            aria-label="Search the web"
            aria-pressed={searchEnabled}
            onClick={() => onSearchEnabledChange(!searchEnabled)}
            disabled={controlsDisabled}
            className={cn(
              "h-8 gap-1.5 rounded-full px-2.5",
              searchEnabled
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <HugeiconsIcon icon={GlobalSearchIcon} className="size-4" />
            <span className="text-sm max-[420px]:sr-only">Search</span>
          </Button>
        ) : null}
        <Select
          value={modelId}
          onValueChange={(nextModelId) => nextModelId && onModelChange(nextModelId)}
          items={models.map((model) => ({ value: model.id, label: model.displayName }))}
          disabled={noModels || controlsDisabled}
        >
          <SelectTrigger
            size="sm"
            className={cn(
              "text-muted-foreground hover:text-foreground hover:bg-accent h-8 min-w-0 max-w-52 gap-1.5",
              "rounded-full border-0 bg-transparent px-2.5 shadow-none",
              "[&_svg:last-child]:hidden",
            )}
          >
            <span className="truncate text-sm">{selectedModel?.displayName ?? "Select model"}</span>
            <HugeiconsIcon icon={ArrowDown01Icon} className="size-3.5 shrink-0 opacity-60" />
          </SelectTrigger>
          <SelectContent className="min-w-64">
            {models.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                <span className="max-w-52 truncate">{model.displayName}</span>
                <CapabilityIcons capabilities={model.capabilities} />
                <ContextBadge contextLength={model.contextLength} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {onCancel ? (
            <Button size="sm" variant="ghost" onClick={onCancel} disabled={disabled}>
              Cancel
            </Button>
          ) : null}
          <Button
            size="icon"
            onClick={submit}
            disabled={!canSubmit}
            aria-label={attachments?.queued ? "Sending after uploads finish" : submitLabel}
            aria-busy={attachments?.queued || undefined}
            className="size-8 rounded-full"
          >
            <HugeiconsIcon
              icon={attachments?.queued ? Loading03Icon : ArrowUp02Icon}
              className={cn("size-4", attachments?.queued ? "animate-spin" : "")}
            />
          </Button>
        </div>
      </div>
      {dragging ? (
        // pointer-events-none so dragleave/drop still reach the shell.
        <div className="border-ring/70 bg-background/85 pointer-events-none absolute inset-1 z-10 grid place-items-center rounded-[1.125rem] border-2 border-dashed backdrop-blur-[2px]">
          <span className="text-foreground flex items-center gap-2 text-sm font-medium">
            <HugeiconsIcon icon={Attachment01Icon} className="size-4" />
            Drop files to attach
          </span>
        </div>
      ) : null}
    </div>
  );
});
