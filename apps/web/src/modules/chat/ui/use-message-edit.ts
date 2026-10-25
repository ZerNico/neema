import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useAttachmentUploads } from "~/modules/attachments/client/use-attachment-uploads.ts";
import { skillsQuery } from "~/modules/skills/client/queries.ts";
import type { ConversationData } from "./conversation-window.ts";
import type { associateQuestionResponses } from "./question-responses.ts";
import { useContextSelection } from "./use-context-selection.ts";
import type { useMessageRows } from "./use-message-rows.ts";

/**
 * The message being edited and the draft its editor holds: uploads, skills,
 * collections and the research offer, seeded from the message when it opens.
 */
export function useMessageEdit({
  data,
  questionResponses,
  attachmentsByMessage,
  skillsByUserMessage,
  collectionsByUserMessage,
}: {
  data: ConversationData;
  questionResponses: ReturnType<typeof associateQuestionResponses>;
} & Pick<
  ReturnType<typeof useMessageRows>,
  "attachmentsByMessage" | "skillsByUserMessage" | "collectionsByUserMessage"
>) {
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editResearchEnabled, setEditResearchEnabled] = useState(false);
  // One instance, mounted for the whole view: an edit opens by seeding it, so
  // the chips survive the ChatInput remount that swapping the bubble causes.
  const editUploads = useAttachmentUploads();
  const seedEditUploads = editUploads.seed;
  const resetEditUploads = editUploads.reset;
  const submitEditUploads = editUploads.submit;
  const beginEditSubmission = editUploads.beginSubmission;
  const editUploadCount = editUploads.items.length;
  // Seeded from the edited message, like the uploads above: an edit changes the
  // message's own skills and collections, never the composer's live selection.
  const [editSkillIds, setEditSkillIds] = useState<ReadonlyArray<string>>([]);
  const activeEditingMessage =
    editingMessageId === null
      ? null
      : (data.messages.find((message) => message.id === editingMessageId) ?? null);
  const editContext = useContextSelection({ mode: "installed", agent: data.agent });
  // The composer loads the same list inside itself; the editor is a second
  // consumer, and one shared query key means one fetch.
  const editableSkills = useQuery(skillsQuery);
  const seedEditContext = editContext.seed;
  const settleEditContext = editContext.settle;

  // Sending, answering, retrying and branching all abandon an open edit, and
  // each has to drop its uploads and selections rather than just forgetting
  // which message was being edited.
  const closeEdit = useCallback(() => {
    // Runs on every send/answer/retry/branch, so it must cost nothing when no
    // edit is open: resetting then would throw away the composer's own uploads.
    if (!editingMessageId) return;
    setEditingMessageId(null);
    setEditSkillIds([]);
    setEditResearchEnabled(false);
    settleEditContext();
    // Structured edits have no upload lifecycle of their own.
    if (!questionResponses.hiddenMessageIds.has(editingMessageId)) resetEditUploads();
  }, [resetEditUploads, editingMessageId, questionResponses, settleEditContext]);
  // Seeds from the per-message maps. Opening an editor while another is
  // open is an ordinary switch: the previous draft goes with its unmounted row.
  const openEdit = useCallback(
    (messageId: string) => {
      setEditingMessageId(messageId);
      // The offer belongs to the edit being written, not to the one before it.
      setEditResearchEnabled(false);
      if (questionResponses.hiddenMessageIds.has(messageId)) {
        // An answer edit has no uploads of its own, so there is nothing to seed.
        // Only a switch away from another editor leaves chips needing clearing.
        if (editingMessageId !== null && editingMessageId !== messageId) resetEditUploads();
      } else {
        // Seeded as existing/claimed: removing one only drops it from the
        // replacement set, it is released by the save itself.
        seedEditUploads(attachmentsByMessage.get(messageId) ?? []);
      }
      setEditSkillIds((skillsByUserMessage.get(messageId) ?? []).map((skill) => skill.id));
      // The person's own collections only: the agent's ride with the agent.
      seedEditContext(collectionsByUserMessage.get(messageId) ?? []);
    },
    [
      attachmentsByMessage,
      seedEditUploads,
      resetEditUploads,
      questionResponses,
      editingMessageId,
      skillsByUserMessage,
      collectionsByUserMessage,
      seedEditContext,
    ],
  );

  return {
    activeEditingMessage,
    editResearchEnabled,
    setEditResearchEnabled,
    editUploads,
    submitEditUploads,
    beginEditSubmission,
    editUploadCount,
    editSkillIds,
    setEditSkillIds,
    editContext,
    settleEditContext,
    editableSkills,
    setEditingMessageId,
    closeEdit,
    openEdit,
  };
}
