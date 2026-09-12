import { useQuery } from "@tanstack/react-query";
import { skillsQuery } from "~/modules/skills/client/queries.ts";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ChatInput } from "./chat-input.tsx";
import type { ComposerContext } from "./context-picker.tsx";
import type { GenerationMode } from "../research-schema.ts";
import { useAttachmentUploads } from "~/modules/attachments/client/use-attachment-uploads.ts";
import type { ConversationMode } from "../schema.ts";
import {
  DRAFT_CONVERSATION,
  useDesktop,
  useDesktopOutdated,
  useFolder,
} from "~/modules/desktop/client/bridge.ts";
import { FolderStrip, type PermissionControl } from "~/modules/desktop/ui/folder-strip.tsx";

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
  /**
   * Which conversation the folder attaches to. A new chat has no id yet, so it
   * uses the draft key and rebinds after the first message creates one.
   */
  conversationId?: string | undefined;
  /**
   * A new chat offers the choice; an existing chat's mode is fixed at creation
   * and passed as a value. Work needs a folder from the desktop app: without
   * one the composer says so and refuses to send.
   */
  mode?:
    | { kind: "choose"; value: ConversationMode; onChange: (mode: ConversationMode) => void }
    | { kind: "fixed"; value: ConversationMode }
    | undefined;
  /** How much a work chat asks before acting. Only an existing chat has one. */
  permissions?: PermissionControl | undefined;
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
    conversationId,
    mode,
    permissions,
  },
  ref,
) {
  const desktop = useDesktop();
  const outdated = useDesktopOutdated();
  const folderKey = conversationId ?? DRAFT_CONVERSATION;
  const folder = useFolder(folderKey);
  const working = mode?.value === "work";
  // The reason is the nudge: sending stays blocked until it is gone.
  const blockedReason = !working
    ? null
    : outdated
      ? "This desktop app is out of date. Update it to continue this work chat."
      : !desktop
        ? "This is a work chat. Open it in the desktop app to continue."
        : folder?.status.kind !== "attached"
          ? "Choose a folder from this computer to continue."
          : null;
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
    if (disabled || !modelId || blockedReason) return;
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
    <div className="flex flex-col">
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
        // Offered only where Work can be honoured: a new chat, in the desktop app.
        {...(mode?.kind === "choose" && desktop
          ? { mode: { value: mode.value, onChange: mode.onChange } }
          : {})}
        blockedReason={blockedReason}
        attachments={attachments}
        {...(context ? { context } : {})}
      />
      {/* Under the composer and inset, so it reads as part of it. Only a work
          chat has a folder to show, and only the desktop app can show one. */}
      {working && folder ? <FolderStrip folder={folder} permissions={permissions} /> : null}
    </div>
  );
});
