import { useEffect, useRef, useState } from "react";
import { ChatInput } from "./chat-input.tsx";
import { useAttachmentUploads } from "~/modules/attachments/client/use-attachment-uploads.ts";

export function Composer({
  onSend,
  onStop,
  disabled,
  modelId,
  onModelChange,
  searchEnabled,
  onSearchEnabledChange,
  textareaDisabled = false,
  controlsDisabled,
}: {
  /** Rejects on failure — the draft and chips survive so the user can retry. */
  onSend: (content: string, attachmentIds: ReadonlyArray<string>) => Promise<unknown>;
  /** Present only while a response is generating; swaps send for stop. */
  onStop?: (() => void) | undefined;
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
  const attachments = useAttachmentUploads();

  // A queued send fires after the uploads settle, by which time the draft may
  // have grown — read it then, not at the moment Enter was pressed.
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const send = () => {
    if (disabled || !modelId) return;
    attachments.submit((attachmentIds) => {
      const content = draftRef.current.trim();
      if (!content && attachmentIds.length === 0) return;
      void onSend(content, attachmentIds).then(
        () => {
          setDraft("");
          // The message owns them now; dropping the chips must not delete them.
          attachments.markClaimed();
          textareaRef.current?.focus();
        },
        () => {},
      );
    });
  };

  return (
    <ChatInput
      ref={textareaRef}
      value={draft}
      onValueChange={setDraft}
      onSubmit={send}
      {...(onStop ? { onStop } : {})}
      disabled={disabled}
      textareaDisabled={textareaDisabled}
      {...(controlsDisabled !== undefined ? { controlsDisabled } : {})}
      modelId={modelId}
      onModelChange={onModelChange}
      searchEnabled={searchEnabled}
      onSearchEnabledChange={onSearchEnabledChange}
      attachments={attachments}
    />
  );
}
