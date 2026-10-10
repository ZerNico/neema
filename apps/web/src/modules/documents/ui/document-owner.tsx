import { File01Icon, Table01Icon } from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { sessionUserQuery } from "~/modules/auth/client.ts";
import { projectMembersQuery } from "~/modules/projects/client/queries.ts";
import {
  useCallback,
  Suspense,
  lazy,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
  type ReactNode,
  type Ref,
  useRef,
} from "react";
import { useDocument } from "../client/use-document.ts";
import { useSheet } from "../sheet/client/use-sheet.ts";
import { SheetPanelActions } from "../sheet/ui/sheet-panel-actions.tsx";
import { Spinner } from "~/ui/primitives/spinner";
import { DocumentPanelActions, DocumentPanelBody } from "./document-panel.tsx";
import { documentSubtitle } from "./document-subtitle.ts";
import type { DocumentAsk, EditorHooks, MentionCandidate } from "./rich-editor/editor-hooks.ts";
import {
  useDetailPanel,
  useDetailPanelReconciler,
  useDetailPanelSelectedId,
} from "~/ui/detail-panel-context.ts";
import {
  EMPTY_DOCUMENT_IDS,
  DocumentPanelContext,
  type DocumentPanelEntry,
} from "./document-panel-context.ts";

export interface DocumentOwnerHandle {
  /** Every mounted document, so a send never races typing it has not stored yet. */
  flush: () => Promise<boolean>;
  /** The blocks the person has selected in one document's open editor. */
  selectedBlocks: (documentId: string) => string[];
}
interface DocumentOwnerProps {
  documentIds: ReadonlyArray<string>;
  goneIds?: ReadonlySet<string>;
  onGone: (documentId: string) => void;
  children: ReactNode;
  ref?: Ref<DocumentOwnerHandle> | undefined;
  /** Documents the answer being watched just created; their panel opens by itself. */
  autoOpenIds?: ReadonlySet<string> | undefined;
  /**
   * Sends a request typed inside a document as a chat message, with the spot
   * it was asked at selected; false when it cannot go now. Absent outside a chat.
   */
  onAsk?: DocumentAsk | undefined;
  /** Moves focus to the chat's input, keeping the document's selection for the message. */
  onFocusComposer?: (() => void) | undefined;
}
// The grid and the formula engine load with the first open sheet, not the chat.
const SheetPanelBody = lazy(() => import("../sheet/ui/sheet-panel.tsx"));

interface Session {
  entry: DocumentPanelEntry;
  flush: () => Promise<boolean>;
  selectedBlocks: () => string[];
}

/** Controllers stay mounted when transcript rows or panel bodies are replaced. */
export function DocumentOwner({
  documentIds,
  goneIds = EMPTY_DOCUMENT_IDS,
  onGone,
  autoOpenIds,
  onAsk,
  onFocusComposer,
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
      selectedBlocks: (documentId) => sessions.get(documentId)?.selectedBlocks() ?? [],
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
          onAsk={onAsk}
          onFocusComposer={onFocusComposer}
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
  onAsk,
  onFocusComposer,
}: {
  documentId: string;
  publish: (documentId: string, session: Session) => void;
  forget: (documentId: string) => void;
  onGone: (documentId: string) => void;
  autoOpen: boolean;
  onAsk: DocumentAsk | undefined;
  onFocusComposer: (() => void) | undefined;
}) {
  const panel = useDetailPanel();
  const selected = useDetailPanelSelectedId();
  // The editor for everyone (read-only for a viewer) until they pick the Markdown.
  // The actions row the editor portals its formatting controls into.
  const [toolbarSlot, setToolbarSlot] = useState<HTMLElement | null>(null);
  const id = `document:${documentId}`;
  // Only the document open in the panel holds a live connection.
  const controller = useDocument(documentId, selected === id);
  const isSheet = controller.document?.kind === "sheet";
  const sheet = useSheet(documentId, selected === id && isSheet);
  const unpersisted = useCallback(
    () => controller.unpersisted() || sheet.unpersisted(),
    [controller, sheet],
  );
  const flush = useCallback(async () => {
    const [text, cells] = await Promise.all([controller.flush(), sheet.flush()]);
    return text && cells;
  }, [controller, sheet]);
  useBlocker({
    shouldBlockFn: async () => unpersisted() && !(await flush()),
    enableBeforeUnload: unpersisted,
  });
  const { data: me } = useQuery(sessionUserQuery);
  const subtitle = documentSubtitle(controller, me?.id);
  const projectId = controller.document?.projectId ?? null;
  const { data: members } = useQuery({
    ...projectMembersQuery(projectId ?? ""),
    enabled: projectId !== null,
  });
  const people = useMemo<MentionCandidate[]>(
    () => [
      ...(me ? [{ id: me.id, label: me.name, detail: me.email }] : []),
      ...(members?.users ?? [])
        .filter((user) => user.userId !== me?.id)
        .map((user) => ({ id: user.userId, label: user.name, detail: user.email })),
    ],
    [me, members],
  );
  // Read when the @ list opens, so members loading late still show.
  const candidates = useRef<MentionCandidate[]>([]);
  useEffect(() => {
    candidates.current = people;
  }, [people]);
  const hooks = useMemo<EditorHooks>(
    () => ({
      mentions: () => candidates.current,
      ask: onAsk ? (request, target) => onAsk(request, { ...target, documentId }) : null,
      focusComposer: onFocusComposer ?? null,
    }),
    [documentId, onAsk, onFocusComposer],
  );
  const request = useMemo(
    () => ({
      id,
      title: controller.document?.title ?? "Document",
      subtitle,
      icon: isSheet ? Table01Icon : File01Icon,
      restorable: true,
      actions: isSheet ? (
        <SheetPanelActions document={controller.document} />
      ) : (
        <DocumentPanelActions controller={controller} toolbarSlot={setToolbarSlot} />
      ),
      body: isSheet ? (
        <Suspense
          fallback={<Spinner aria-label="Loading sheet" className="text-muted-foreground" />}
        >
          <SheetPanelBody controller={sheet} />
        </Suspense>
      ) : (
        <DocumentPanelBody controller={controller} toolbarSlot={toolbarSlot} hooks={hooks} />
      ),
    }),
    [controller, hooks, id, isSheet, sheet, subtitle, toolbarSlot],
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
      inProject: available ? controller.document?.projectId != null : null,
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
  const selectedBlocks = controller.selectedBlocks;
  useEffect(() => {
    publish(documentId, { entry, flush, selectedBlocks });
  }, [documentId, entry, flush, selectedBlocks, publish]);
  useEffect(() => () => forget(documentId), [documentId, forget]);
  const gone =
    controller.status === "gone" ||
    sheet.state?.status === "gone" ||
    (controller.query.isSuccess && controller.query.data === null && !unpersisted());
  useEffect(() => {
    if (gone) onGone(documentId);
  }, [documentId, gone, onGone]);
  return null;
}
