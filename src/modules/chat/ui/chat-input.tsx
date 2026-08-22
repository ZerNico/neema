import {
  ArrowDown01Icon,
  ArrowUp02Icon,
  GlobalSearchIcon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { forwardRef, useEffect } from "react";
import { chatModelsQuery, webSearchAvailabilityQuery } from "../client/queries.ts";
import { CHAT_INPUT_SHELL_CLASS, ChatTextarea } from "./chat-textarea.tsx";
import { CapabilityIcons, ContextBadge } from "~/modules/providers/ui/capability-icons.tsx";
import { Button } from "~/ui/primitives/button";
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
    placeholder = "Message…",
    autoFocus = false,
    submitLabel = "Send",
    className,
  },
  textareaRef,
) {
  const { data: models } = useSuspenseQuery(chatModelsQuery);
  const { data: searchAvailability } = useQuery(webSearchAvailabilityQuery);
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

  const submit = () => {
    if (!disabled && value.trim() && selectedModel) onSubmit();
  };

  return (
    <div className={cn(CHAT_INPUT_SHELL_CLASS, className)}>
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
        {/* Placeholder for attachments (files, images) — wired up later. */}
        <Button
          size="icon"
          variant="ghost"
          aria-label="Add attachment"
          disabled
          className="text-muted-foreground size-8 rounded-full"
        >
          <HugeiconsIcon icon={PlusSignIcon} className="size-4" />
        </Button>
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
            disabled={disabled || !value.trim() || !selectedModel}
            aria-label={submitLabel}
            className="size-8 rounded-full"
          >
            <HugeiconsIcon icon={ArrowUp02Icon} className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
});
