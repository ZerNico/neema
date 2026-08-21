import { SentIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { chatModelsQuery } from "../client/queries.ts";
import { Button } from "~/ui/primitives/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { Textarea } from "~/ui/primitives/textarea";

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

  // Default to the first available model so the send button works immediately.
  useEffect(() => {
    if (!modelId && models[0]) onModelChange(models[0].id);
  }, [modelId, models, onModelChange]);

  const send = () => {
    const content = draft.trim();
    if (!content || disabled || !modelId) return;
    setDraft("");
    onSend(content);
  };

  return (
    <div className="border-border bg-background mx-auto w-full max-w-3xl rounded-2xl border p-2 shadow-sm">
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        placeholder={models.length === 0 ? "No models configured — ask an admin" : "Message…"}
        className="max-h-48 min-h-12 resize-none border-0 shadow-none focus-visible:ring-0"
        disabled={models.length === 0}
      />
      <div className="flex items-center justify-between gap-2 px-1 pt-1">
        <Select
          value={modelId}
          onValueChange={(value) => value && onModelChange(value)}
          items={models.map((m) => ({ value: m.id, label: m.displayName }))}
        >
          <SelectTrigger size="sm" className="w-56">
            <SelectValue placeholder="Select model" />
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
        >
          <HugeiconsIcon icon={SentIcon} className="size-4" />
        </Button>
      </div>
    </div>
  );
}
