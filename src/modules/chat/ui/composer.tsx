import { useRef, useState } from "react";
import { ChatInput } from "./chat-input.tsx";

export function Composer({
  onSend,
  disabled,
  modelId,
  onModelChange,
  searchEnabled,
  onSearchEnabledChange,
  textareaDisabled = false,
  controlsDisabled,
}: {
  onSend: (content: string) => void;
  disabled: boolean;
  textareaDisabled?: boolean;
  modelId: string | null;
  onModelChange: (modelId: string) => void;
  searchEnabled: boolean;
  onSearchEnabledChange: (enabled: boolean) => void;
  controlsDisabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    const content = draft.trim();
    if (!content || disabled || !modelId) return;
    setDraft("");
    onSend(content);
    textareaRef.current?.focus();
  };

  return (
    <ChatInput
      ref={textareaRef}
      value={draft}
      onValueChange={setDraft}
      onSubmit={send}
      disabled={disabled}
      textareaDisabled={textareaDisabled}
      {...(controlsDisabled !== undefined ? { controlsDisabled } : {})}
      modelId={modelId}
      onModelChange={onModelChange}
      searchEnabled={searchEnabled}
      onSearchEnabledChange={onSearchEnabledChange}
    />
  );
}
