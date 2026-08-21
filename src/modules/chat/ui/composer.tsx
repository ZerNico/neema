import { ArrowDown01Icon, ArrowUp02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { chatModelsQuery } from "../client/queries.ts";
import { Button } from "~/ui/primitives/button";
import { Select, SelectContent, SelectItem, SelectTrigger } from "~/ui/primitives/select";
import { cn } from "~/ui/utils";

export function Composer({
  onSend,
  disabled,
  modelId,
  onModelChange,
}: {
  onSend: (content: string) => void;
  disabled: boolean;
  modelId: string | null;
  onModelChange: (modelId: string) => void;
}) {
  const { data: models } = useSuspenseQuery(chatModelsQuery);
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Default to the first available model so the send button works immediately.
  useEffect(() => {
    if (!modelId && models[0]) onModelChange(models[0].id);
  }, [modelId, models, onModelChange]);

  // Auto-grow the textarea with content, capped via max-height.
  const resize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  // biome/oxlint: resize on every draft change
  useEffect(resize, [draft]);

  const send = () => {
    const content = draft.trim();
    if (!content || disabled || !modelId) return;
    setDraft("");
    onSend(content);
    textareaRef.current?.focus();
  };

  const noModels = models.length === 0;
  const selectedModel = models.find((m) => m.id === modelId);

  return (
    // Width/centering comes from the parent wrapper, which mirrors the
    // message column exactly (max-w-3xl + px-4) so both edges line up.
    <div
      className={cn(
        "border-border bg-background w-full rounded-[1.375rem] border shadow-sm transition-shadow",
        "focus-within:border-ring/40 focus-within:shadow-md",
      )}
    >
      <textarea
        ref={textareaRef}
        rows={1}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        placeholder={noModels ? "No models configured — ask an admin" : "Message…"}
        disabled={noModels}
        className={cn(
          "placeholder:text-muted-foreground block max-h-52 w-full resize-none overflow-y-auto",
          "bg-transparent px-4 pb-1 pt-3.5 text-sm leading-6 outline-none disabled:opacity-60",
        )}
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
        <Select
          value={modelId}
          onValueChange={(value) => value && onModelChange(value)}
          items={models.map((m) => ({ value: m.id, label: m.displayName }))}
        >
          <SelectTrigger
            size="sm"
            className={cn(
              "text-muted-foreground hover:text-foreground hover:bg-accent h-8 w-auto gap-1.5",
              "rounded-full border-0 bg-transparent px-2.5 shadow-none",
              "[&_svg:last-child]:hidden", // drop the default chevron; we render our own
            )}
          >
            <span className="max-w-44 truncate text-sm">
              {selectedModel?.displayName ?? "Select model"}
            </span>
            <HugeiconsIcon icon={ArrowDown01Icon} className="size-3.5 shrink-0 opacity-60" />
          </SelectTrigger>
          <SelectContent>
            {models.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                {model.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="icon"
          onClick={send}
          disabled={disabled || !draft.trim() || !modelId}
          aria-label="Send"
          className="ml-auto size-8 rounded-full"
        >
          <HugeiconsIcon icon={ArrowUp02Icon} className="size-4" />
        </Button>
      </div>
    </div>
  );
}
