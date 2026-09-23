import { useQuery } from "@tanstack/react-query";
import { skillsQuery } from "~/modules/skills/client/queries.ts";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ChatInput } from "./chat-input.tsx";
import { extractReferences, restoreReferences, type MessageReference } from "../references.ts";
import type { ComposerContext } from "./context-picker.tsx";
import { useAttachmentUploads } from "~/modules/attachments/client/use-attachment-uploads.ts";
import type { ConversationMode } from "../schema.ts";
import {
  useDesktop,
  useDesktopOutdated,
  type FolderState,
} from "~/modules/desktop/client/bridge.ts";
import {
  useWorkspaceImports,
  type WorkspaceImports,
} from "~/modules/desktop/client/use-workspace-imports.ts";
import { FolderStrip, type WorkSettingsControl } from "~/modules/desktop/ui/folder-strip.tsx";

/** What a parent may do to the composer from outside a keystroke. */
export interface ComposerHandle {
  /** Replaces the draft (a conversation starter) and focuses the textarea. */
  seedDraft: (text: string) => void;
  /** Consumes a navigation prefill once, without replacing typing or moving focus. */
  prefillDraft: (text: string) => void;
  /** Puts the caret in the textarea, since opening a chat should be ready to type. */
  focus: () => void;
}

interface ComposerProps {
  /** Rejects on failure. The draft and chips survive so the user can retry. */
  onSend: (
    content: string,
    attachmentIds: ReadonlyArray<string>,
    researchEnabled: boolean,
    skillIds?: ReadonlyArray<string>,
    workspaceFiles?: ReadonlyArray<string>,
    workspaceImports?: WorkspaceImports,
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
   * A new chat offers the choice; an existing chat's mode is fixed at creation
   * and passed as a value. Work needs the desktop app: in a browser the
   * composer says so and refuses to send.
   */
  mode?:
    | { kind: "choose"; value: ConversationMode; onChange: (mode: ConversationMode) => void }
    | { kind: "fixed"; value: ConversationMode }
    | undefined;
  /** A work chat's policy: how much it asks, how far commands reach. */
  settings?: WorkSettingsControl | undefined;
  /**
   * The view's folder state, shared with the send so the strip and the
   * message agree. Null in a browser.
   */
  folder?: FolderState | null | undefined;
  /**
   * From `useWorkGate`: the folder check is not ready. Send is blocked; the
   * textarea stays usable. The parent owns this so the strip and the send
   * cannot disagree.
   */
  readOnly?: boolean | undefined;
  /**
   * The conversation's id for workspace imports. Only a work chat inside the
   * desktop app uses it; anything else uploads to the server.
   */
  conversationId?: string | undefined;
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
    textareaDisabled,
    controlsDisabled,
    context,
    initialSkillId,
    mode,
    settings,
    folder = null,
    readOnly = false,
    conversationId,
  },
  ref,
) {
  const desktop = useDesktop();
  const outdated = useDesktopOutdated();
  const working = mode?.value === "work";
  // Work needs the desktop app, not a folder: the strip invites one, and the
  // folder tools are withheld until it is attached.
  const blockedReason = !working
    ? null
    : outdated
      ? "This desktop app is out of date. Update it to continue this work chat."
      : !desktop
        ? "This is a work chat. Open it in the desktop app to continue."
        : null;
  const sendDisabled = disabled || (working && readOnly);
  const skills = useQuery(skillsQuery);
  const [skillIds, setSkillIds] = useState<string[]>(() =>
    initialSkillId ? [initialSkillId] : [],
  );
  const [draft, setDraft] = useState("");
  // What a prefill links to (an agent or schedule to edit), shown as chips and
  // written back into the text on send.
  const [references, setReferences] = useState<MessageReference[]>([]);
  const [researchEnabled, setResearchEnabled] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const touched = useRef(false);
  const attachments = useAttachmentUploads();
  // A work chat inside the desktop app keeps files local: drops and pastes
  // land in the chat's workspace, and the send reports their names instead of
  // uploading. Everywhere else the server-attachment path is unchanged.
  const local = working && !!desktop && conversationId !== undefined;
  const imports = useWorkspaceImports(conversationId ?? "");
  const workspaceImports = local ? imports : null;
  const serverAttachments = local ? null : attachments;
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
        const typed = textareaRef.current?.value;
        if (typed) {
          setDraft(typed);
          return;
        }
        const prefill = extractReferences(text);
        setDraft(prefill.text);
        setReferences(prefill.references);
      },
      focus: () => textareaRef.current?.focus(),
    }),
    [],
  );

  // Text and selections stay editable while uploads settle; dispatch the current request.
  const requestRef = useRef({
    draft,
    references,
    researchEnabled,
    skillIds,
    onSend,
    blockedReason,
    disabled: sendDisabled,
    modelId,
  });
  useEffect(() => {
    requestRef.current = {
      draft,
      references,
      researchEnabled,
      skillIds,
      onSend,
      blockedReason,
      disabled: sendDisabled,
      modelId,
    };
  });

  const send = () => {
    if (sendDisabled || !modelId || blockedReason) return;
    touched.current = true;
    const submitted = requestRef.current;
    // Both rows can be settling at once in a browser work chat that lost its
    // desktop window mid-session; the imports queue only ever runs in-app.
    (workspaceImports ?? attachments).submit((claimed: ReadonlyArray<string>) => {
      const workspaceFiles = workspaceImports ? claimed : [];
      const sendRest = (attachmentIds: ReadonlyArray<string>) => {
        const current = requestRef.current;
        if (submitted.blockedReason || submitted.disabled || !submitted.modelId) return;
        const content = restoreReferences(current.draft.trim(), current.references);
        if (!content && attachmentIds.length === 0 && workspaceFiles.length === 0) return;
        // A plain send keeps the arity older callers were written against;
        // only a work chat's local files add the fifth argument.
        const request = workspaceImports
          ? submitted.onSend(
              content,
              attachmentIds,
              submitted.researchEnabled,
              current.skillIds,
              workspaceFiles,
              workspaceImports,
            )
          : submitted.onSend(content, attachmentIds, submitted.researchEnabled, current.skillIds);
        void request.then(
          () => {
            setDraft("");
            setReferences([]);
            setSkillIds([]);
            setResearchEnabled(false);
            // The message owns them now; dropping the chips must not delete them.
            attachments.markClaimed();
            workspaceImports?.markClaimed();
            textareaRef.current?.focus();
          },
          () => {},
        );
      };
      if (workspaceImports) attachments.submit(sendRest);
      else sendRest(claimed);
    });
  };

  return (
    <div className="flex flex-col">
      <ChatInput
        ref={textareaRef}
        skills={{ items: skills.data ?? [], selectedIds: skillIds, onChange: setSkillIds }}
        references={{
          items: references,
          onRemove: (removed) =>
            setReferences((current) => current.filter((reference) => reference !== removed)),
        }}
        value={draft}
        onValueChange={(value) => {
          touched.current = true;
          setDraft(value);
        }}
        onSubmit={send}
        {...(onStop ? { onStop } : {})}
        disabled={sendDisabled}
        textareaDisabled={textareaDisabled ?? disabled}
        controlsDisabled={controlsDisabled ?? sendDisabled}
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
        {...(serverAttachments ? { attachments: serverAttachments } : {})}
        {...(workspaceImports ? { workspaceImports } : {})}
        {...(context ? { context } : {})}
      />
      {/* Under the composer and inset, so it reads as part of it. Only a work
          chat has a folder to show, and only the desktop app can show one. */}
      {working && folder ? <FolderStrip folder={folder} settings={settings} /> : null}
    </div>
  );
});
