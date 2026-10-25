import type { ComposerIntegrations } from "~/modules/integrations/client/use-chat-integrations.ts";
import type { ComposerFieldHandle } from "./chat-textarea.tsx";
import { useQuery } from "@tanstack/react-query";
import { skillsQuery } from "~/modules/skills/client/queries.ts";
import { capabilitiesQuery } from "~/modules/groups/client/queries.ts";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { collapseMotion } from "~/ui/motion-presets.ts";
import { useAppReducedMotion } from "~/ui/reduced-motion.ts";
import { ChatInput, type ImageModelChoice } from "./chat-input.tsx";
import { extractReferences, restoreReferences, type MessageReference } from "../references.ts";
import type { ComposerContext } from "./context-picker.tsx";
import { useAttachmentUploads } from "~/modules/attachments/client/use-attachment-uploads.ts";
import type { ConversationMode } from "../schema.ts";
import type { ReasoningEffort } from "~/modules/providers/model-config.ts";
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
import { QueueStrip, type QueuedMessage } from "./queue-strip.tsx";

/** What a parent may do to the composer from outside a keystroke. */
export interface ComposerHandle {
  /** Replaces the draft (a conversation starter) and focuses the textarea. */
  seedDraft: (text: string) => void;
  /** Consumes a navigation prefill once, without replacing typing or moving focus. */
  prefillDraft: (text: string) => void;
  /**
   * Adds text a ```ui block offered, for the reader to send: fills an empty
   * draft, or appends to what was typed rather than replacing it.
   */
  offerDraft: (text: string) => void;
  /** Puts the caret in the textarea, since opening a chat should be ready to type. */
  focus: () => void;
}

/** A queued message as the composer reopens it for editing. */
export interface EditableQueuedMessage extends QueuedMessage {
  input: {
    researchEnabled: boolean;
    reasoningEffort?: ReasoningEffort | null;
    skillIds?: ReadonlyArray<string> | undefined;
  };
}

export interface ComposerQueue {
  entries: ReadonlyArray<EditableQueuedMessage>;
  /** Entries steered into the running answer. */
  steeringIds: ReadonlySet<string>;
  paused: { reason: string; canDispatch: boolean } | null;
  onSteer: (entryId: string) => void;
  onRemove: (entryId: string) => void;
  onSendNow: (entryId: string) => void;
  /** Why Send now would do nothing useful here, if it would not. */
  sendNowBlocked: string | null;
  onDispatch: () => void;
  /** Saves an edited entry in place. Rejects on failure; the edit stays open. */
  onReplace: (
    entryId: string,
    ...submission: Parameters<ComposerProps["onSend"]>
  ) => Promise<unknown>;
  /** Restores what the parent owns (model, search, collections) for this entry. */
  onEditStart: (entry: EditableQueuedMessage) => void;
  /** Hands those settings back after a cancel or a save. */
  onEditEnd: () => void;
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
  /**
   * Present while a response is live: submitting queues a snapshot of the
   * draft, files included, instead of sending. Same arguments as `onSend`.
   */
  onQueue?: ComposerProps["onSend"] | undefined;
  queue?: ComposerQueue | undefined;
  disabled: boolean;
  textareaDisabled?: boolean;
  modelId: string | null;
  onModelChange: (modelId: string) => void;
  searchEnabled: boolean;
  onSearchEnabledChange: (enabled: boolean) => void;
  reasoningEffort?: ReasoningEffort | null | undefined;
  onReasoningEffortChange?: ((effort: ReasoningEffort | null) => void) | undefined;
  /** The chat's image model and how to change it; absent hides the picker. */
  imageModel?: ImageModelChoice | undefined;
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
  /** This chat's connected services; the view owns them so a send can carry them. */
  integrations?: ComposerIntegrations | undefined;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    imageModel,
    onSend,
    onStop,
    onQueue,
    queue,
    disabled,
    modelId,
    onModelChange,
    searchEnabled,
    onSearchEnabledChange,
    reasoningEffort,
    onReasoningEffortChange,
    textareaDisabled,
    controlsDisabled,
    context,
    initialSkillId,
    mode,
    settings,
    folder = null,
    readOnly = false,
    conversationId,
    integrations,
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
  const { data: capabilities } = useQuery(capabilitiesQuery);
  const skills = useQuery({ ...skillsQuery, enabled: !!capabilities?.skillsUse });
  const [skillIds, setSkillIds] = useState<string[]>(() =>
    initialSkillId ? [initialSkillId] : [],
  );
  const [draft, setDraft] = useState("");
  const draftRevision = useRef(0);
  const updateDraft = useCallback((value: string) => {
    draftRevision.current++;
    setDraft(value);
  }, []);
  const dispatching = useRef(false);
  const [requestPending, setRequestPending] = useState(false);
  // What a prefill links to (an agent or schedule to edit), shown as chips and
  // written back into the text on send.
  const [references, setReferences] = useState<MessageReference[]>([]);
  const [researchEnabled, setResearchEnabled] = useState(false);
  const canResearch = !!capabilities?.deepResearch && !!capabilities.webSearch;
  const activeResearch = researchEnabled && canResearch;
  // The queued message open for editing. Its row stays in the queue, and its
  // files stay claimed by it, until the replacement commits.
  const [editingId, setEditingId] = useState<string | null>(null);
  const editSession = useRef(0);
  const queueCollapse = collapseMotion(useAppReducedMotion());
  const textareaRef = useRef<ComposerFieldHandle>(null);
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
        updateDraft(text);
        textareaRef.current?.focus();
      },
      prefillDraft: (text) => {
        if (touched.current) return;
        touched.current = true;
        // Someone may already have typed before the prefill arrived.
        const typed = textareaRef.current?.value();
        if (typed) {
          updateDraft(typed);
          return;
        }
        const prefill = extractReferences(text);
        updateDraft(prefill.text);
        setReferences(prefill.references);
      },
      offerDraft: (text) => {
        touched.current = true;
        const typed = textareaRef.current?.value() ?? "";
        updateDraft(typed.trim() ? `${typed.trimEnd()}\n${text}` : text);
        textareaRef.current?.focus();
      },
      focus: () => textareaRef.current?.focus(),
    }),
    [updateDraft],
  );

  // Text and selections stay editable while uploads settle; dispatch the current request.
  const requestRef = useRef({
    draft,
    references,
    researchEnabled: activeResearch,
    skillIds,
    onSend,
    onQueue,
    editingId,
    onReplace: queue?.onReplace,
    blockedReason,
    disabled: sendDisabled,
    modelId,
  });
  useEffect(() => {
    requestRef.current = {
      draft,
      references,
      researchEnabled: activeResearch,
      skillIds,
      onSend,
      onQueue,
      editingId,
      onReplace: queue?.onReplace,
      blockedReason,
      disabled: sendDisabled,
      modelId,
    };
  });

  const clearDraft = () => {
    updateDraft("");
    setReferences([]);
    setSkillIds([]);
    setResearchEnabled(false);
  };

  // Only from an empty composer: seeding replaces the draft and its uploads,
  // and a half-written message must never be discarded to open another one.
  const editBlocked =
    editingId !== null
      ? "Finish the edit that is open first"
      : draft.trim() !== "" || attachments.items.length > 0
        ? "Send or clear your draft to edit a queued message"
        : null;

  const startEdit = (entryId: string) => {
    const entry = queue?.entries.find((item) => item.id === entryId);
    if (!entry || !queue || editBlocked) return;
    touched.current = true;
    editSession.current++;
    setEditingId(entry.id);
    // Stored with references restored to markup, like any sent message; the
    // composer shows them as tags again.
    const seeded = extractReferences(entry.content);
    updateDraft(seeded.text);
    setReferences(seeded.references);
    setSkillIds([...(entry.input.skillIds ?? [])]);
    setResearchEnabled(entry.input.researchEnabled);
    // Seeded chips are marked existing: removing one only drops it from the
    // replacement, and cancelling never deletes the queued message's files.
    attachments.seed(entry.attachments);
    queue.onEditStart(entry);
    textareaRef.current?.focus();
  };

  const cancelEdit = () => {
    editSession.current++;
    setEditingId(null);
    clearDraft();
    // Deletes uploads added during the edit; the seeded ones stay queued.
    attachments.reset();
    queue?.onEditEnd();
  };

  const send = () => {
    if (dispatching.current || sendDisabled || !modelId || blockedReason) return;
    touched.current = true;
    const submitted = requestRef.current;
    const submittedEditSession = editSession.current;
    // Both rows can be settling at once in a browser work chat that lost its
    // desktop window mid-session; the imports queue only ever runs in-app.
    attachments.submit((attachmentIds) => {
      const sendRest = (workspaceFiles: ReadonlyArray<string>) => {
        const current = requestRef.current;
        if (
          dispatching.current ||
          submitted.blockedReason ||
          submitted.disabled ||
          !submitted.modelId
        )
          return;
        const content = restoreReferences(current.draft.trim(), current.references);
        if (!content && attachmentIds.length === 0 && workspaceFiles.length === 0) return;
        const submission = [
          content,
          attachmentIds,
          submitted.researchEnabled,
          current.skillIds,
        ] as const;
        // An edit saves in place whether or not a response is running;
        // otherwise a live response turns the send into a queued snapshot.
        // Workspace files never queue (their send reserves the turn), and the
        // input keeps Stop for such a draft, so they always go out as a send.
        const editing = submitted.editingId;
        const submittedRevision = draftRevision.current;
        dispatching.current = true;
        setRequestPending(true);
        let releaseImports: (() => void) | undefined;
        let releaseAttachments: (() => void) | undefined;
        const finish = () => {
          releaseAttachments?.();
          releaseImports?.();
          dispatching.current = false;
          setRequestPending(false);
        };
        try {
          releaseAttachments = attachments.beginSubmission(attachmentIds);
          releaseImports = workspaceImports?.beginSubmission(workspaceFiles);
        } catch {
          finish();
          return;
        }
        const request = Promise.resolve().then(() => {
          return editing && submitted.onReplace
            ? submitted.onReplace(editing, ...submission)
            : submitted.onQueue && workspaceFiles.length === 0
              ? submitted.onQueue(...submission)
              : workspaceImports
                ? submitted.onSend(...submission, workspaceFiles, workspaceImports)
                : submitted.onSend(...submission);
        });
        void request.then(() => {
          if (draftRevision.current === submittedRevision) {
            updateDraft("");
            setReferences((value) => (value === current.references ? [] : value));
            setSkillIds((value) => (value === current.skillIds ? [] : value));
            setResearchEnabled((value) => (value === submitted.researchEnabled ? false : value));
          }
          attachments.markClaimed(attachmentIds);
          workspaceImports?.markClaimed(workspaceFiles);
          // Reopening even the same entry starts a new borrowed-settings session.
          if (editing && editSession.current === submittedEditSession) {
            editSession.current++;
            setEditingId(null);
            queue?.onEditEnd();
          }
          finish();
          textareaRef.current?.focus();
        }, finish);
      };
      if (workspaceImports) workspaceImports.submit(sendRest);
      else sendRest([]);
    });
  };

  return (
    <div className="flex flex-col">
      <AnimatePresence initial={false}>
        {queue && queue.entries.length > 0 ? (
          <m.div key="queue" {...queueCollapse}>
            <QueueStrip
              entries={queue.entries}
              generating={!!onStop}
              steeringIds={queue.steeringIds}
              editingId={editingId}
              editBlocked={editBlocked}
              paused={queue.paused}
              onSteer={queue.onSteer}
              onRemove={queue.onRemove}
              onEdit={startEdit}
              onSendNow={queue.onSendNow}
              sendNowBlocked={queue.sendNowBlocked}
              onDispatch={queue.onDispatch}
            />
          </m.div>
        ) : null}
      </AnimatePresence>
      <ChatInput
        ref={textareaRef}
        {...(capabilities?.skillsUse
          ? { skills: { items: skills.data ?? [], selectedIds: skillIds, onChange: setSkillIds } }
          : {})}
        references={{
          items: references,
          onRemove: (removed) =>
            setReferences((current) => current.filter((reference) => reference !== removed)),
        }}
        value={draft}
        onValueChange={(value) => {
          touched.current = true;
          updateDraft(value);
        }}
        onSubmit={send}
        {...(onStop ? { onStop } : {})}
        // Saving an edit is the submit while a response runs, like queueing.
        queueing={onQueue !== undefined || editingId !== null}
        {...(editingId
          ? {
              queueLabel: "Save queued message",
              submitLabel: "Save queued message",
              onCancel: cancelEdit,
            }
          : {})}
        disabled={sendDisabled || requestPending}
        textareaDisabled={textareaDisabled ?? disabled}
        controlsDisabled={controlsDisabled ?? sendDisabled}
        modelId={modelId}
        onModelChange={onModelChange}
        searchEnabled={searchEnabled}
        onSearchEnabledChange={onSearchEnabledChange}
        reasoningEffort={reasoningEffort}
        onReasoningEffortChange={onReasoningEffortChange}
        {...(imageModel ? { imageModel } : {})}
        researchEnabled={activeResearch}
        {...(canResearch ? { onResearchEnabledChange: setResearchEnabled } : {})}
        // Offered only where Work can be honoured: a new chat, in the desktop app.
        {...(mode?.kind === "choose" && desktop && capabilities?.work
          ? { mode: { value: mode.value, onChange: mode.onChange } }
          : {})}
        blockedReason={blockedReason}
        {...(serverAttachments && capabilities?.attachments
          ? { attachments: serverAttachments }
          : {})}
        {...(workspaceImports && capabilities?.work ? { workspaceImports } : {})}
        {...(context && (capabilities?.agentsUse || capabilities?.knowledgeUse) ? { context } : {})}
        {...(integrations ? { integrations } : {})}
      />
      {/* Under the composer and inset, so it reads as part of it. Only a work
          chat has a folder to show, and only the desktop app can show one. */}
      {working && folder ? <FolderStrip folder={folder} settings={settings} /> : null}
    </div>
  );
});
