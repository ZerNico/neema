import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { AgentDraftHandle } from "~/modules/agents/ui/agent-draft-owner.tsx";
import type { DocumentOwnerHandle } from "~/modules/documents/ui/document-owner.tsx";
import type { AskTarget } from "~/modules/documents/ui/rich-editor/editor-hooks.ts";
import type { ScheduleDraftHandle } from "~/modules/schedules/ui/schedule-draft-owner.tsx";
import { useDetailPanelSelectedId } from "~/ui/detail-panel-context.ts";
import { AlreadyTold } from "~/ui/error-toast.ts";
import type { ToolActivity } from "../client/use-message-stream.ts";
import type { ConversationData } from "./conversation-window.ts";
import { useDiscoveredArtifacts } from "./use-discovered-artifacts.ts";

/** Shared, so a conversation with nothing forgotten keeps its memos stable. */
const NO_IDS: ReadonlySet<string> = new Set();

/**
 * The drafts and documents this chat shows in its panels, the ones dismissed
 * from them, and what a send reads from them: unsaved changes and the open
 * document's selection.
 */
export function useChatArtifacts({
  data,
  conversationId,
  tools,
  streamingId,
  isMobile,
}: {
  data: ConversationData;
  conversationId: string;
  /** The streaming answer's tool activity. */
  tools: readonly ToolActivity[];
  streamingId: string | undefined;
  isMobile: boolean;
}) {
  const agentDraft = useRef<AgentDraftHandle>(null);
  const scheduleDraft = useRef<ScheduleDraftHandle>(null);
  const documents = useRef<DocumentOwnerHandle>(null);
  const selectedPanelId = useDetailPanelSelectedId();
  // The chat's own documents, and its project's while the person may still use it.
  const projectId = data.project?.role ? data.project.id : null;
  const { discoveredDrafts, discoveredScheduleDrafts, discoveredDocuments, liveCreated } =
    useDiscoveredArtifacts({
      data,
      conversationId,
      projectId,
      tools,
      streamingId,
      isMobile,
    });
  // A draft goes with the answer that opened it, like a document, so the loader
  // summary plus live results are the whole truth. A discarded one is held out
  // until the refreshed loader and tool rows stop naming it.
  const [forgottenDrafts, setForgottenDrafts] = useState<{
    conversationId: string;
    ids: ReadonlySet<string>;
  }>({ conversationId, ids: new Set() });
  const scopedForgottenDrafts =
    forgottenDrafts.conversationId === conversationId ? forgottenDrafts.ids : NO_IDS;
  const draftIds = useMemo(
    () => [...discoveredDrafts].filter((draftId) => !scopedForgottenDrafts.has(draftId)).toSorted(),
    [discoveredDrafts, scopedForgottenDrafts],
  );
  const scheduleDraftIds = useMemo(
    () =>
      [...discoveredScheduleDrafts]
        .filter((draftId) => !scopedForgottenDrafts.has(draftId))
        .toSorted(),
    [discoveredScheduleDrafts, scopedForgottenDrafts],
  );
  // Draft ids are UUIDs, so one set serves both kinds.
  const forgetDraft = useCallback(
    (draftId: string) =>
      setForgottenDrafts((current) => {
        const ids =
          current.conversationId === conversationId ? new Set(current.ids) : new Set<string>();
        ids.add(draftId);
        return { conversationId, ids };
      }),
    [conversationId],
  );
  const hasAgentDraft = draftIds.length > 0;
  const hasScheduleDraft = scheduleDraftIds.length > 0;
  // Unlike a draft, a document does not outlive the answer that created it: a
  // rewind deletes it, so the loader summary plus live results are the whole
  // truth and there is nothing to retain across a retry.
  const [forgottenDocuments, setForgottenDocuments] = useState<{
    conversationId: string;
    ids: ReadonlySet<string>;
  }>({ conversationId, ids: new Set() });
  const scopedForgottenDocuments =
    forgottenDocuments.conversationId === conversationId ? forgottenDocuments.ids : NO_IDS;
  const documentIds = useMemo(
    () =>
      [...discoveredDocuments]
        .filter((documentId) => !scopedForgottenDocuments.has(documentId))
        .toSorted(),
    [discoveredDocuments, scopedForgottenDocuments],
  );
  const forgetDocument = useCallback(
    (documentId: string) =>
      setForgottenDocuments((current) => {
        const ids =
          current.conversationId === conversationId ? new Set(current.ids) : new Set<string>();
        ids.add(documentId);
        return { conversationId, ids };
      }),
    [conversationId],
  );
  const hasDocument = documentIds.length > 0;
  const openDocumentId =
    selectedPanelId?.startsWith("document:") &&
    documentIds.includes(selectedPanelId.slice("document:".length))
      ? selectedPanelId.slice("document:".length)
      : undefined;
  // Read by sends after their awaits, when this render's value may be stale: the latest
  // committed one.
  const openDocument = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    openDocument.current = openDocumentId;
  }, [openDocumentId]);
  const documentFocus = (asked?: AskTarget & { documentId: string }) => {
    const id = asked?.documentId ?? openDocument.current;
    if (!id) return {};
    const selected = asked ? [...asked.blocks] : (documents.current?.selectedBlocks(id) ?? []);
    return {
      openDocument: {
        id,
        ...(selected.length ? { selected } : {}),
        ...(asked?.thread ? { thread: asked.thread } : {}),
      },
    };
  };

  // Blocking a generation has to say so: onMutate throwing cancels the mutation,
  // and send/retry/branch carry no onError of their own, so without this the
  // button would simply do nothing.
  const flushAgentDraft = async () => {
    if (hasAgentDraft && !(await agentDraft.current?.flush())) {
      toast.error("Resolve the changes in your agent draft before continuing.");
      throw new AlreadyTold("agent draft has unresolved changes");
    }
  };
  const flushScheduleDraft = async () => {
    if (hasScheduleDraft && !(await scheduleDraft.current?.flush())) {
      toast.error("Resolve the changes in your schedule draft before continuing.");
      throw new AlreadyTold("schedule draft has unresolved changes");
    }
  };
  const flushDocuments = async () => {
    if (hasDocument && !(await documents.current?.flush())) {
      toast.error("Resolve the changes in your document before continuing.");
      throw new AlreadyTold("document has unresolved changes");
    }
  };

  return {
    agentDraft,
    scheduleDraft,
    documents,
    draftIds,
    scheduleDraftIds,
    documentIds,
    scopedForgottenDocuments,
    forgetDraft,
    forgetDocument,
    liveCreated,
    documentFocus,
    /** Saves every open draft and document, refusing the generation if one cannot be. */
    flushArtifacts: async () => {
      await flushAgentDraft();
      await flushScheduleDraft();
      await flushDocuments();
    },
  };
}
