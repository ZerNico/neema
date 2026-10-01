import { File01Icon } from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { sessionUserQuery } from "~/modules/auth/client.ts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
  type ReactNode,
  type Ref,
  useRef,
} from "react";
import { useDocument } from "../client/use-document.ts";
import { taskProgress } from "../task-items.ts";
import { DocumentPanelActions, DocumentPanelBody, documentSubtitle } from "./document-panel.tsx";
import type { DocumentEditorMode } from "./rich-editor/document-editor.tsx";
import {
  useDetailPanel,
  useDetailPanelReconciler,
  useDetailPanelSelectedId,
} from "~/ui/detail-panel.tsx";

export interface DocumentOwnerHandle {
  /** Every mounted document, so a send never races typing it has not stored yet. */
  flush: () => Promise<boolean>;
}
interface DocumentOwnerProps {
  documentIds: ReadonlyArray<string>;
  goneIds?: ReadonlySet<string>;
  onGone: (documentId: string) => void;
  children: ReactNode;
  ref?: Ref<DocumentOwnerHandle> | undefined;
  /** Documents the answer being watched just created; their panel opens by itself. */
  autoOpenIds?: ReadonlySet<string> | undefined;
}
interface DocumentPanelEntry {
  title: string | null;
  status: string;
  /** Rendered as the card's meta line, so the transcript shows checklist progress. */
  tasks: { done: number; total: number } | null;
  /** Shared with the project rather than kept in this chat; null until loaded. */
  inProject: boolean | null;
  chars: number;
  expanded: boolean;
  open: (() => void) | null;
  retry: (() => void) | null;
}
interface Session {
  entry: DocumentPanelEntry;
  flush: () => Promise<boolean>;
}
interface DocumentPanelScope {
  owned: ReadonlySet<string>;
  gone: ReadonlySet<string>;
  entries: ReadonlyMap<string, DocumentPanelEntry>;
}
const EMPTY_DOCUMENT_IDS = new Set<string>();
const DocumentPanelContext = createContext<DocumentPanelScope>({
  owned: EMPTY_DOCUMENT_IDS,
  gone: EMPTY_DOCUMENT_IDS,
  entries: new Map(),
});

export const useDocumentPanel = (documentId: string) => {
  const scope = useContext(DocumentPanelContext);
  return {
    owned: scope.owned.has(documentId),
    gone: scope.gone.has(documentId),
    entry: scope.entries.get(documentId) ?? null,
  };
};

/** Controllers stay mounted when transcript rows or panel bodies are replaced. */
export function DocumentOwner({
  documentIds,
  goneIds = EMPTY_DOCUMENT_IDS,
  onGone,
  autoOpenIds,
  children,
  ref,
}: DocumentOwnerProps) {
  const [sessions, setSessions] = useState<ReadonlyMap<string, Session>>(new Map());
  useDetailPanelReconciler("document:", documentIds);
  const publish = useCallback(
    (documentId: string, session: Session) =>
      setSessions((current) => {
        const previous = current.get(documentId)?.entry;
        return previous &&
          previous.title === session.entry.title &&
          previous.status === session.entry.status &&
          previous.tasks?.done === session.entry.tasks?.done &&
          previous.tasks?.total === session.entry.tasks?.total &&
          previous.chars === session.entry.chars &&
          previous.expanded === session.entry.expanded &&
          !previous.open === !session.entry.open &&
          !previous.retry === !session.entry.retry
          ? current
          : new Map(current).set(documentId, session);
      }),
    [],
  );
  const forget = useCallback(
    (documentId: string) =>
      setSessions((current) => {
        const next = new Map(current);
        next.delete(documentId);
        return next;
      }),
    [],
  );
  useImperativeHandle(
    ref,
    () => ({
      flush: async () => {
        let ready = true;
        for (const session of sessions.values()) ready = (await session.flush()) && ready;
        return ready;
      },
    }),
    [sessions],
  );
  const value = useMemo(
    () => ({
      owned: new Set(documentIds),
      gone: goneIds,
      entries: new Map([...sessions].map(([documentId, session]) => [documentId, session.entry])),
    }),
    [documentIds, goneIds, sessions],
  );
  return (
    <>
      {documentIds.map((documentId) => (
        <DocumentSession
          key={documentId}
          documentId={documentId}
          publish={publish}
          forget={forget}
          onGone={onGone}
          autoOpen={autoOpenIds?.has(documentId) ?? false}
        />
      ))}
      <DocumentPanelContext.Provider value={value}>{children}</DocumentPanelContext.Provider>
    </>
  );
}

function DocumentSession({
  documentId,
  publish,
  forget,
  onGone,
  autoOpen,
}: {
  documentId: string;
  publish: (documentId: string, session: Session) => void;
  forget: (documentId: string) => void;
  onGone: (documentId: string) => void;
  autoOpen: boolean;
}) {
  const panel = useDetailPanel();
  const selected = useDetailPanelSelectedId();
  // The editor for everyone (read-only for a viewer) until they pick the Markdown.
  const [mode, setMode] = useState<DocumentEditorMode>("live");
  // The actions row the editor portals its formatting controls into.
  const [toolbarSlot, setToolbarSlot] = useState<HTMLElement | null>(null);
  const id = `document:${documentId}`;
  // Only the document open in the panel holds a live connection.
  const controller = useDocument(documentId, selected === id);
  useBlocker({
    shouldBlockFn: async () => controller.unpersisted() && !(await controller.flush()),
    enableBeforeUnload: controller.unpersisted,
  });
  const { data: me } = useQuery(sessionUserQuery);
  const subtitle = documentSubtitle(controller, me?.id);
  const request = useMemo(
    () => ({
      id,
      title: controller.document?.title ?? "Document",
      subtitle,
      icon: File01Icon,
      restorable: true,
      actions: (
        <DocumentPanelActions
          controller={controller}
          mode={mode}
          onModeChange={setMode}
          toolbarSlot={setToolbarSlot}
        />
      ),
      body: <DocumentPanelBody controller={controller} mode={mode} toolbarSlot={toolbarSlot} />,
    }),
    [controller, id, mode, subtitle, toolbarSlot],
  );
  // The card opens the request this session last committed, not the one its
  // own render captured: a card published just before the connection landed
  // would otherwise reopen the panel on the body without the editor.
  const latestRequest = useRef(request);
  useEffect(() => {
    latestRequest.current = request;
    panel.refresh(request);
  }, [panel, request]);
  useEffect(() => () => panel.release(id), [id, panel]);
  const available = controller.document !== null;
  // Opens the panel once, when a document this answer just created has loaded.
  // Only live ones are passed in, so reloads and old chats never pop a panel.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (!autoOpen || autoOpened.current || !available) return;
    autoOpened.current = true;
    panel.open(request);
  }, [autoOpen, available, panel, request]);
  const failed = controller.query.isError || controller.query.data === null;
  const entry = useMemo<DocumentPanelEntry>(
    () => ({
      title: available ? (controller.document?.title ?? null) : null,
      status: !available
        ? failed
          ? "Could not load document"
          : "Loading document…"
        : controller.error
          ? "Changes not saved yet"
          : subtitle,
      tasks: available ? taskProgress(controller.content) : null,
      inProject: available ? controller.document?.projectId != null : null,
      chars: controller.content.length,
      expanded: selected === id,
      open: available ? () => panel.open(latestRequest.current) : null,
      retry: failed
        ? () => {
            void controller.query.refetch();
          }
        : null,
    }),
    [available, controller, failed, id, panel, selected, subtitle],
  );
  const flush = controller.flush;
  useEffect(() => {
    publish(documentId, { entry, flush });
  }, [documentId, entry, flush, publish]);
  useEffect(() => () => forget(documentId), [documentId, forget]);
  const gone =
    controller.status === "gone" ||
    (controller.query.isSuccess && controller.query.data === null && !controller.unpersisted());
  useEffect(() => {
    if (gone) onGone(documentId);
  }, [documentId, gone, onGone]);
  return null;
}
