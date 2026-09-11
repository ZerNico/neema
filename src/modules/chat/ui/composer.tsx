import { useQuery } from "@tanstack/react-query";
import { skillsQuery } from "~/modules/skills/client/queries.ts";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ChatInput } from "./chat-input.tsx";
import type { ComposerContext } from "./context-picker.tsx";
import type { GenerationMode } from "../research-schema.ts";
import { useAttachmentUploads } from "~/modules/attachments/client/use-attachment-uploads.ts";

/** What a parent may do to the composer from outside a keystroke. */
export interface ComposerHandle {
  /** Replaces the draft (a conversation starter) and focuses the textarea. */
  seedDraft: (text: string) => void;
  /** Consumes a navigation prefill once, without replacing typing or moving focus. */
  prefillDraft: (text: string) => void;
  /** Puts the caret in the textarea — opening a chat should be ready to type. */
  focus: () => void;
}

interface ComposerProps {
  /** Rejects on failure — the draft and chips survive so the user can retry. */
  onSend: (
    content: string,
    attachmentIds: ReadonlyArray<string>,
    generationMode?: GenerationMode,
    skillIds?: ReadonlyArray<string>,
  ) => Promise<unknown>;
  /** Present only while a response is generating; swaps send for stop. */
  onStop?: (() => void) | undefined;
  disabled: boolean;
  textareaDisabled?: boolean;
  modelId: string | null;
  onModelChange: (modelId: string, source?: "default") => void;
  searchEnabled: boolean;
  onSearchEnabledChange: (enabled: boolean) => void;
  controlsDisabled?: boolean;
  context?: ComposerContext | undefined;
  initialSkillId?: string | null | undefined;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    onSend,
    onStop,
    disabled,
    modelId,
    onModelChange,
    searchEnabled,
    onSearchEnabledChange,
    textareaDisabled = false,
    controlsDisabled,
    context,
    initialSkillId,
  },
  ref,
) {
  const skills = useQuery(skillsQuery);
  const [skillIds, setSkillIds] = useState<string[]>(() =>
    initialSkillId ? [initialSkillId] : [],
  );
  const [draft, setDraft] = useState("");
  const [researchEnabled, setResearchEnabled] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const touched = useRef(false);
  const attachments = useAttachmentUploads();
  // Seeding happens from the click that chose the starter, never from an
  // effect watching a prop: the state change belongs to that event.
  useImperativeHandle(
    ref,
    () => ({
      seedDraft: (text) => {
        touched.current = true;
        setDraft(text);
        textareaRef.current?.focus();
      },
      prefillDraft: (text) => {
        if (touched.current) return;
        touched.current = true;
        // A user may have typed into the server-rendered textarea before hydration.
        setDraft(textareaRef.current?.value || text);
      },
      focus: () => textareaRef.current?.focus(),
    }),
    [],
  );

  // Text and selections stay editable while uploads settle; dispatch the current request.
  const requestRef = useRef({ draft, researchEnabled, skillIds, onSend });
  useEffect(() => {
    requestRef.current = { draft, researchEnabled, skillIds, onSend };
  });

  const send = () => {
    if (disabled || !modelId) return;
    touched.current = true;
    attachments.submit((attachmentIds) => {
      const current = requestRef.current;
      const content = current.draft.trim();
      if (!content && attachmentIds.length === 0) return;
      const request = current.onSend(
        content,
        attachmentIds,
        current.researchEnabled ? "research" : undefined,
        current.skillIds,
      );
      void request.then(
        () => {
          setDraft("");
          setSkillIds([]);
          setResearchEnabled(false);
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
      skills={{ items: skills.data ?? [], selectedIds: skillIds, onChange: setSkillIds }}
      value={draft}
      onValueChange={(value) => {
        touched.current = true;
        setDraft(value);
      }}
      onSubmit={send}
      {...(onStop ? { onStop } : {})}
      disabled={disabled}
      textareaDisabled={textareaDisabled}
      {...(controlsDisabled !== undefined ? { controlsDisabled } : {})}
      modelId={modelId}
      onModelChange={onModelChange}
      searchEnabled={searchEnabled}
      onSearchEnabledChange={onSearchEnabledChange}
      researchEnabled={researchEnabled}
      onResearchEnabledChange={setResearchEnabled}
      attachments={attachments}
      {...(context ? { context } : {})}
    />
  );
});
