import type { ComposerFolders } from "~/modules/computer/client/use-composer-folders.ts";
import { m } from "~/paraglide/messages.js";
import type { ComposerIntegrations } from "~/modules/integrations/client/use-chat-integrations.ts";
import type { ComposerFieldHandle } from "./chat-textarea.tsx";
import { useQuery } from "@tanstack/react-query";
import { skillsQuery } from "~/modules/skills/client/queries.ts";
import { capabilitiesQuery } from "~/modules/groups/client/queries.ts";
import { AnimatePresence } from "motion/react";
import * as motion from "motion/react-m";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { collapseMotion } from "~/ui/motion-presets.ts";
import { useAppReducedMotion } from "~/ui/reduced-motion.ts";
import { ChatInput, type ImageModelChoice } from "./chat-input.tsx";
import { extractReferences, restoreReferences, type MessageReference } from "../references.ts";
import type { ComposerContext } from "./context-picker.tsx";
import { useAttachmentUploads } from "~/modules/attachments/client/use-attachment-uploads.ts";
import type { ReasoningEffort } from "~/modules/providers/model-config.ts";
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
  /** This chat's connected services; the view owns them so a send can carry them. */
  integrations?: ComposerIntegrations | undefined;
  /** The chat's folders on this machine; see `useComposerFolders`. */
  folders?: ComposerFolders | undefined;
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
    integrations,
    folders,
  },
  ref,
) {
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
    disabled: disabled,
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
      disabled: disabled,
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
      ? m.chat_queue_edit_blocked_open()
      : draft.trim() !== "" || attachments.items.length > 0
        ? m.chat_queue_edit_blocked_draft()
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
    if (dispatching.current || disabled || !modelId) return;
    touched.current = true;
    const submitted = requestRef.current;
    const submittedEditSession = editSession.current;
    attachments.submit((attachmentIds) => {
      const current = requestRef.current;
      if (dispatching.current || submitted.disabled || !submitted.modelId) return;
      const content = restoreReferences(current.draft.trim(), current.references);
      if (!content && attachmentIds.length === 0) return;
      const submission = [
        content,
        attachmentIds,
        submitted.researchEnabled,
        current.skillIds,
      ] as const;
      // An edit saves in place whether or not a response is running;
      // otherwise a live response turns the send into a queued snapshot.
      const editing = submitted.editingId;
      const submittedRevision = draftRevision.current;
      dispatching.current = true;
      setRequestPending(true);
      let releaseAttachments: (() => void) | undefined;
      const finish = () => {
        releaseAttachments?.();
        dispatching.current = false;
        setRequestPending(false);
      };
      try {
        releaseAttachments = attachments.beginSubmission(attachmentIds);
      } catch {
        finish();
        return;
      }
      const request = Promise.resolve().then(() =>
        editing && submitted.onReplace
          ? submitted.onReplace(editing, ...submission)
          : submitted.onQueue
            ? submitted.onQueue(...submission)
            : submitted.onSend(...submission),
      );
      void request.then(() => {
        if (draftRevision.current === submittedRevision) {
          updateDraft("");
          setReferences((value) => (value === current.references ? [] : value));
          setSkillIds((value) => (value === current.skillIds ? [] : value));
          setResearchEnabled((value) => (value === submitted.researchEnabled ? false : value));
        }
        attachments.markClaimed(attachmentIds);
        // Reopening even the same entry starts a new borrowed-settings session.
        if (editing && editSession.current === submittedEditSession) {
          editSession.current++;
          setEditingId(null);
          queue?.onEditEnd();
        }
        finish();
        textareaRef.current?.focus();
      }, finish);
    });
  };

  return (
    <div className="flex flex-col">
      <AnimatePresence initial={false}>
        {queue && queue.entries.length > 0 ? (
          <motion.div key="queue" {...queueCollapse}>
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
          </motion.div>
        ) : null}
      </AnimatePresence>
      <ChatInput
        ref={textareaRef}
        {...(capabilities?.skillsUse
          ? { skills: { items: skills.data ?? [], selectedIds: skillIds, onChange: setSkillIds } }
          : {})}
        folders={folders}
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
              queueLabel: m.chat_queue_save(),
              submitLabel: m.chat_queue_save(),
              onCancel: cancelEdit,
            }
          : {})}
        disabled={disabled || requestPending}
        textareaDisabled={textareaDisabled ?? disabled}
        controlsDisabled={controlsDisabled ?? disabled}
        modelId={modelId}
        onModelChange={onModelChange}
        searchEnabled={searchEnabled}
        onSearchEnabledChange={onSearchEnabledChange}
        reasoningEffort={reasoningEffort}
        onReasoningEffortChange={onReasoningEffortChange}
        {...(imageModel ? { imageModel } : {})}
        researchEnabled={activeResearch}
        {...(canResearch ? { onResearchEnabledChange: setResearchEnabled } : {})}
        {...(capabilities?.attachments ? { attachments } : {})}
        {...(context && (capabilities?.agentsUse || capabilities?.knowledgeUse) ? { context } : {})}
        {...(integrations ? { integrations } : {})}
      />
    </div>
  );
});
