import { IntegrationLogo } from "~/modules/integrations/ui/integration-logo.tsx";
import { useIntegrationDirectory } from "~/modules/integrations/client/directory.ts";
import {
  KnowledgeSourcesSection,
  SourcePickerDialog,
  type SourceTarget,
} from "~/modules/integrations/ui/knowledge-sources-section.tsx";
import { useSyncableIntegrations } from "~/modules/integrations/client/use-syncable-integrations.ts";
import { DocumentSourcePanel } from "./document-source-panel.tsx";
import { InfiniteSentinel } from "~/modules/chat/ui/infinite-sentinel.tsx";
import { useDetailPanel } from "~/ui/detail-panel-context.ts";
import {
  Delete02Icon,
  Download04Icon,
  File01Icon,
  FolderLibraryIcon,
  MoreHorizontalIcon,
  NoteIcon,
  PencilEdit02Icon,
  PlusSignIcon,
  RefreshIcon,
  UserGroupIcon,
  Upload04Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { useEffect, useRef, useState } from "react";
import { useFileDrop } from "~/ui/use-file-drop.ts";
import { toast } from "sonner";
import { knowledgeCollectionQuery } from "../client/queries.ts";
import { capabilitiesQuery } from "~/modules/groups/client/queries.ts";
import { KNOWLEDGE_LIMITS, searchState, type KnowledgeDocument } from "../schema.ts";
import {
  addKnowledgeNote,
  deleteKnowledgeCollection,
  readKnowledgeDocument,
  deleteKnowledgeDocument,
  rebuildKnowledgeIndex,
  replaceKnowledgeNote,
  retryKnowledgeDocument,
  uploadKnowledgeDocument,
} from "../server/functions.ts";
import { CollectionDialog } from "./knowledge-page.tsx";
import { AccessDialog } from "~/modules/sharing/ui/access-dialog.tsx";
import { useConfirm } from "~/ui/confirm-context.ts";
import { useAppForm } from "~/ui/form/app-form.ts";
import {
  EmptyState,
  ErrorState,
  ListCard,
  ListRow,
  ListSkeleton,
  Page,
  Section,
} from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button, buttonVariants } from "~/ui/primitives/button";
import { FieldError } from "~/ui/primitives/field";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { useAppReducedMotion } from "~/ui/reduced-motion.ts";
import * as motion from "motion/react-m";
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";
import { cn } from "~/ui/utils";
import { toastError } from "~/ui/error-toast.ts";

// Built when the dialog mounts: a check's message is a plain string, read then
// in the page's language.
const noteForm = () =>
  Schema.Struct({
    title: Schema.String.check(
      Schema.isMinLength(1, { message: m.knowledge_note_title_required() }),
      Schema.isMaxLength(KNOWLEDGE_LIMITS.maxNameLength, {
        message: m.knowledge_note_title_short(),
      }),
    ),
    content: Schema.String.check(
      Schema.isMinLength(1, { message: m.knowledge_note_content_required() }),
      Schema.isMaxLength(KNOWLEDGE_LIMITS.maxNoteChars, {
        message: m.knowledge_note_content_limit({
          max: KNOWLEDGE_LIMITS.maxNoteChars.toLocaleString(getLocale()),
        }),
      }),
    ),
  });

const statusBadge = (document: KnowledgeDocument) => {
  if (document.status === "failed")
    return (
      <Badge variant="destructive" className="max-w-full whitespace-normal">
        {m.knowledge_status_failed()}
      </Badge>
    );
  if (document.status !== "ready")
    return <Badge variant="secondary">{m.knowledge_status_preparing()}</Badge>;
  if (document.replacement)
    return (
      <Badge variant={document.replacement.status === "failed" ? "destructive" : "secondary"}>
        {document.replacement.status === "failed"
          ? m.knowledge_status_update_failed()
          : m.knowledge_status_updating()}
      </Badge>
    );
  const search = searchState(document);
  if (search === "basic")
    return <Badge variant="outline">{m.knowledge_status_basic_search()}</Badge>;
  if (search === "preparing")
    return <Badge variant="outline">{m.knowledge_status_preparing_search()}</Badge>;
  return null;
};

function NoteDialog({
  collectionId,
  editing,
  onOpenChange,
}: {
  collectionId: string;
  /** "new", a note to edit, or null when closed. */
  editing: "new" | KnowledgeDocument | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  // The list payload carries no bodies, so replacing a note starts by reading
  // its published text through the same authorized endpoint the viewer uses.
  // A note can hold more than one read returns; page until the end.
  const source = editing !== null && editing !== "new" && editing.versionId ? editing : null;
  const initialized = useRef(source === null);
  const current = useQuery({
    queryKey: ["knowledge", "note", source?.id, source?.versionId],
    enabled: source !== null,
    staleTime: 0,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      let text = "";
      let offset = 0;
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- each page's offset comes from the last
        const excerpt = await readKnowledgeDocument({
          signal,
          data: {
            collectionId,
            documentId: source!.id,
            versionId: source!.versionId!,
            startOffset: offset,
            maxChars: 16_000,
          },
        });
        text += excerpt.content;
        if (excerpt.nextOffset === null) return text;
        offset = excerpt.nextOffset;
      }
    },
  });
  const [validator] = useState(() => Schema.toStandardSchemaV1(noteForm()));
  const form = useAppForm({
    defaultValues: { title: source?.title ?? "", content: "" },
    validators: { onSubmit: validator },
    onSubmit: async ({ value }) => {
      if (editing === null || !initialized.current) return;
      try {
        if (editing === "new")
          await addKnowledgeNote({
            data: { collectionId, title: value.title, content: value.content },
          });
        else
          await replaceKnowledgeNote({
            data: {
              collectionId,
              documentId: editing.id,
              title: value.title,
              content: value.content,
            },
          });
        await queryClient.invalidateQueries({ queryKey: ["knowledge"] });
        onOpenChange(false);
        form.reset();
      } catch (error) {
        toastError(m.knowledge_note_save_failed(), error);
      }
    },
  });
  // Keep the editor disabled until its first seed; refetches never replace a draft.
  const seed = current.data;
  useEffect(() => {
    if (!initialized.current && seed !== undefined) {
      form.setFieldValue("content", seed);
      initialized.current = true;
    }
  }, [form, seed]);
  const loading = source !== null && seed === undefined;
  return (
    <Dialog
      open={editing !== null}
      onOpenChange={(next) => {
        if (!next && form.state.isSubmitting) return;
        onOpenChange(next);
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {editing === "new" ? m.knowledge_note_add() : m.knowledge_note_replace()}
          </DialogTitle>
          <DialogDescription>
            {editing === "new"
              ? m.knowledge_note_add_description()
              : m.knowledge_note_replace_description()}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (!form.state.isSubmitting) void form.handleSubmit();
          }}
        >
          <form.AppField name="title">
            {(field) => (
              <field.TextField
                label={m.knowledge_note_title()}
                placeholder={m.knowledge_note_title_placeholder()}
              />
            )}
          </form.AppField>
          {current.isError ? <FieldError>{m.knowledge_note_load_failed()}</FieldError> : null}
          <form.AppField name="content">
            {(field) => (
              <field.TextareaField
                label={m.knowledge_note_label()}
                rows={10}
                disabled={loading}
                {...(loading ? { description: m.knowledge_note_loading() } : {})}
              />
            )}
          </form.AppField>
          <form.AppForm>
            <DialogFooter>
              <form.Subscribe selector={(state) => state.isSubmitting}>
                {(isSubmitting) => (
                  <DialogClose render={<Button variant="outline" disabled={isSubmitting} />}>
                    {m.common_cancel()}
                  </DialogClose>
                )}
              </form.Subscribe>
              {/* Submitting before the text loads would replace it with a blank. */}
              <form.SubmitButton disabled={loading || current.isError}>
                {editing === "new" ? m.knowledge_note_add() : m.knowledge_note_replace()}
              </form.SubmitButton>
            </DialogFooter>
          </form.AppForm>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// The limit only matters once it is close, so it stays out of the way until then.
const documentCount = (count: number) => {
  const max = KNOWLEDGE_LIMITS.maxDocumentsPerCollection;
  if (count >= max) return m.knowledge_documents_full({ count, max });
  if (count >= max * 0.8) return m.knowledge_documents_near_limit({ count, max });
  return m.knowledge_count_documents({ count });
};

/**
 * Rows shown at first and added per step. A full collection is 500 rows, each
 * with its own menu, and mounting them all at once froze the page.
 */
const ROWS_PER_STEP = 100;

export function CollectionPage({ collectionId }: { collectionId: string }) {
  const integrations = useIntegrationDirectory();
  const queryClient = useQueryClient();
  const panel = useDetailPanel();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const detail = useQuery(knowledgeCollectionQuery(collectionId));
  const { data: capabilities } = useQuery(capabilitiesQuery);
  const [renaming, setRenaming] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [note, setNote] = useState<"new" | KnowledgeDocument | null>(null);
  const [syncing, setSyncing] = useState<SourceTarget | null>(null);
  const [shownRows, setShownRows] = useState(ROWS_PER_STEP);
  const syncable = useSyncableIntegrations();
  const fileInput = useRef<HTMLInputElement>(null);
  const replacing = useRef<string | null>(null);
  const reduced = useAppReducedMotion();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["knowledge"] });

  const upload = useMutation({
    mutationFn: async (input: { file: File; documentId: string | null }) => {
      const body = new FormData();
      body.set("collectionId", collectionId);
      body.set(
        "title",
        input.file.name.replace(/\.[^.]+$/, "").slice(0, KNOWLEDGE_LIMITS.maxNameLength) ||
          m.knowledge_upload_default_title(),
      );
      if (input.documentId) body.set("documentId", input.documentId);
      body.set("file", input.file);
      return uploadKnowledgeDocument({ data: body });
    },
    onSuccess: invalidate,
    onError: (error) => toastError(m.knowledge_upload_failed(), error),
  });
  // A drop can carry several files; each is its own upload with its own
  // outcome, so one bad file does not swallow the rest.
  const uploadMany = (files: Iterable<File>) => {
    for (const file of files) upload.mutate({ file, documentId: null });
  };
  const canEdit = !!detail.data?.collection.canEdit && !!capabilities?.knowledgeCreate;
  const full = (detail.data?.documents.length ?? 0) >= KNOWLEDGE_LIMITS.maxDocumentsPerCollection;
  const { dragging, handlers: dropHandlers } = useFileDrop({
    enabled: canEdit && !full,
    onDrop: uploadMany,
  });
  const remove = useMutation({
    mutationFn: (documentId: string) => deleteKnowledgeDocument({ data: { documentId } }),
    onSuccess: invalidate,
    onError: (error) => toastError(m.knowledge_document_delete_failed(), error),
  });
  const retry = useMutation({
    mutationFn: (documentId: string) => retryKnowledgeDocument({ data: { documentId } }),
    onSuccess: invalidate,
    onError: (error) => toastError(m.knowledge_document_retry_failed(), error),
  });
  const rebuild = useMutation({
    mutationFn: () => rebuildKnowledgeIndex({ data: { collectionId } }),
    onSuccess: async ({ reextracted, reembedded }) => {
      await invalidate();
      const total = reextracted + reembedded;
      toast.success(
        total === 0
          ? m.knowledge_rebuild_up_to_date()
          : m.knowledge_rebuild_started({ count: total }),
      );
    },
    onError: (error) => toastError(m.knowledge_rebuild_failed(), error),
  });
  const removeCollection = useMutation({
    mutationFn: () => deleteKnowledgeCollection({ data: { collectionId } }),
    onSuccess: async () => {
      await invalidate();
      await navigate({ to: "/knowledge" });
    },
    onError: (error) => toastError(m.knowledge_collection_delete_failed(), error),
  });

  if (detail.isError)
    return (
      <Page
        title={m.knowledge_collection_title()}
        backTo="/knowledge"
        backLabel={m.knowledge_title()}
      >
        <ErrorState
          title={m.knowledge_collection_load_failed()}
          description={m.knowledge_collection_load_failed_description()}
          onRetry={() => {
            void detail.refetch();
          }}
        />
      </Page>
    );
  if (!detail.data)
    return (
      <Page
        title={m.knowledge_collection_title()}
        backTo="/knowledge"
        backLabel={m.knowledge_title()}
      >
        <ListSkeleton label={m.knowledge_collection_loading()} />
      </Page>
    );
  const { collection, documents } = detail.data;
  // Synced pages are listed under their source, not one row each here; they
  // still count toward the collection's limit.
  const ownDocuments = documents.filter((document) => !document.source);
  const syncedDocuments = documents.filter((document) => document.source);
  const onlySynced = ownDocuments.length === 0 && syncedDocuments.length > 0;
  const pickFile = (documentId: string | null) => {
    replacing.current = documentId;
    fileInput.current?.click();
  };

  return (
    <Page
      title={collection.name}
      description={
        collection.description ||
        (collection.ownerName
          ? m.knowledge_collection_shared_read_only({ name: collection.ownerName })
          : undefined)
      }
      backTo="/knowledge"
      backLabel={m.knowledge_title()}
      actions={
        canEdit ? (
          <>
            <Button size="sm" variant="outline" onClick={() => setSharing(true)}>
              <HugeiconsIcon icon={UserGroupIcon} strokeWidth={2} data-icon="inline-start" />
              {m.knowledge_access()}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={m.knowledge_collection_actions()}
                  />
                }
              >
                <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setRenaming(true)}>
                  <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
                  {m.common_rename()}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => rebuild.mutate()} disabled={rebuild.isPending}>
                  <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
                  <span>
                    {m.knowledge_rebuild_index()}
                    <span className="text-muted-foreground block text-xs">
                      {m.knowledge_rebuild_index_description()}
                    </span>
                  </span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => {
                    void confirm({
                      title: m.knowledge_collection_delete_title({ name: collection.name }),
                      description: m.knowledge_collection_delete_description(),
                      confirmLabel: m.knowledge_collection_delete(),
                    }).then((confirmed) => {
                      if (confirmed) removeCollection.mutate();
                    });
                  }}
                >
                  <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                  {m.knowledge_collection_delete()}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : undefined
      }
    >
      {/* The whole documents area is the drop target, like the composer shell.
          The overlay is inert so it never intercepts dragleave/drop. */}
      <div
        className={cn("relative rounded-3xl", dragging && "ring-ring/60 ring-2")}
        data-drop-zone="documents"
        {...dropHandlers}
      >
        <Section
          title={m.knowledge_documents_title()}
          description={documentCount(documents.length)}
          actions={
            canEdit ? (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  accept=".pdf,.txt,.md,.markdown,text/plain,text/markdown,application/pdf"
                  className="sr-only"
                  aria-label={m.knowledge_upload_label()}
                  onChange={(event) => {
                    const files = event.target.files;
                    if (files && files.length > 0) {
                      // Replacing targets one document; a fresh pick may add several.
                      if (replacing.current)
                        upload.mutate({ file: files[0]!, documentId: replacing.current });
                      else uploadMany(files);
                    }
                    event.target.value = "";
                  }}
                />
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<PendingButton size="sm" pending={upload.isPending} disabled={full} />}
                  >
                    <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
                    {m.knowledge_add_menu()}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => pickFile(null)}>
                      <HugeiconsIcon icon={Upload04Icon} strokeWidth={2} />
                      {m.knowledge_upload_files()}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setNote("new")}>
                      <HugeiconsIcon icon={NoteIcon} strokeWidth={2} />
                      {m.knowledge_write_note()}
                    </DropdownMenuItem>
                    {syncable.length > 0 ? <DropdownMenuSeparator /> : null}
                    {syncable.map((integration) => (
                      // The picker asks which account when there are several.
                      <DropdownMenuItem
                        key={integration.id}
                        onClick={() =>
                          setSyncing({
                            integrationId: integration.id,
                            connectionId: integration.connections[0]?.id ?? null,
                          })
                        }
                      >
                        <IntegrationLogo integrationId={integration.id} />
                        {m.knowledge_sync_from({ name: integration.name })}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : undefined
          }
        >
          {/* Synced pages are listed under their source, so a collection holding
              only those is not empty and needs no empty state here. */}
          {onlySynced ? null : ownDocuments.length === 0 ? (
            <EmptyState
              icon={FolderLibraryIcon}
              title={m.knowledge_documents_empty_title()}
              description={
                canEdit ? m.knowledge_documents_empty_owner() : m.knowledge_documents_empty_reader()
              }
            />
          ) : (
            <>
              <ListCard>
                {ownDocuments.slice(0, shownRows).map((document) => (
                  <ListRow key={document.id} className="flex-wrap">
                    {document.source ? (
                      <IntegrationLogo
                        integrationId={document.source.integrationId}
                        variant="tile"
                      />
                    ) : (
                      <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-2xl">
                        <HugeiconsIcon
                          icon={document.kind === "note" ? NoteIcon : File01Icon}
                          strokeWidth={2}
                          className="size-4"
                        />
                      </div>
                    )}
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium">{document.title}</span>
                      <span className="text-muted-foreground truncate text-xs">
                        {document.error ??
                          document.replacement?.error ??
                          [
                            document.fileName,
                            document.pageCount
                              ? m.knowledge_document_pages({ count: document.pageCount })
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                      </span>
                      {document.replacement ? (
                        <span className="text-muted-foreground text-xs">
                          {m.knowledge_document_current_available()}
                        </span>
                      ) : document.status === "ready" && document.semanticStatus === "failed" ? (
                        <span className="text-muted-foreground text-xs">
                          {m.knowledge_document_basic_search()}
                        </span>
                      ) : null}
                    </div>
                    {statusBadge(document)}
                    {canEdit &&
                    (document.status === "failed" || document.replacement?.status === "failed") ? (
                      <PendingButton
                        size="sm"
                        variant="outline"
                        pending={retry.isPending && retry.variables === document.id}
                        disabled={retry.isPending}
                        onClick={() => retry.mutate(document.id)}
                      >
                        {m.knowledge_document_try_again()}
                      </PendingButton>
                    ) : null}
                    {document.versionId && document.kind === "file" ? (
                      <a
                        href={`/api/knowledge/${encodeURIComponent(collectionId)}/${encodeURIComponent(document.id)}/${encodeURIComponent(document.versionId)}`}
                        className={buttonVariants({ size: "icon-sm", variant: "ghost" })}
                        aria-label={m.knowledge_document_download({ name: document.title })}
                        download
                      >
                        <HugeiconsIcon icon={Download04Icon} strokeWidth={2} />
                      </a>
                    ) : null}
                    {document.kind === "note" &&
                    document.versionId &&
                    document.status === "ready" &&
                    document.charCount ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        // oxlint-disable-next-line react/no-unstable-nested-components -- opens a panel with an element; nothing renders here
                        onClick={() =>
                          panel.open({
                            id: `knowledge-note:${document.versionId}`,
                            title: document.title,
                            body: (
                              <DocumentSourcePanel
                                source={{
                                  kind: "document",
                                  index: 0,
                                  title: document.title,
                                  snippet: "",
                                  read: true,
                                  collectionId,
                                  documentId: document.id,
                                  versionId: document.versionId!,
                                  startOffset: 0,
                                  endOffset: document.charCount!,
                                  page: null,
                                  headingPath: "",
                                }}
                              />
                            ),
                          })
                        }
                      >
                        {m.knowledge_document_read_note()}
                      </Button>
                    ) : null}
                    {document.source?.url ? (
                      <a
                        href={document.source.url}
                        target="_blank"
                        rel="noreferrer"
                        className={buttonVariants({ size: "sm", variant: "ghost" })}
                      >
                        {m.knowledge_document_open_in({
                          name: integrations.name(document.source.integrationId),
                        })}
                      </a>
                    ) : null}
                    {canEdit && !document.source ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={m.knowledge_document_actions({ name: document.title })}
                            />
                          }
                        >
                          <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {document.kind === "note" ? (
                            <DropdownMenuItem onClick={() => setNote(document)}>
                              <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
                              {m.knowledge_note_replace()}
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              onClick={() => pickFile(document.id)}
                              disabled={upload.isPending}
                            >
                              <HugeiconsIcon icon={Upload04Icon} strokeWidth={2} />
                              {m.knowledge_document_replace_file()}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => {
                              void confirm({
                                title: m.knowledge_document_delete_title({ name: document.title }),
                                description: m.knowledge_document_delete_description(),
                                confirmLabel: m.knowledge_document_delete(),
                              }).then((confirmed) => {
                                if (confirmed) remove.mutate(document.id);
                              });
                            }}
                          >
                            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                            {m.common_delete()}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </ListRow>
                ))}
              </ListCard>
              <InfiniteSentinel
                hasNext={ownDocuments.length > shownRows}
                isFetching={false}
                onLoadMore={() => setShownRows((rows) => rows + ROWS_PER_STEP)}
              />
            </>
          )}
        </Section>
        <motion.div
          aria-hidden={!dragging}
          inert
          initial={false}
          animate={{ opacity: dragging ? 1 : 0 }}
          transition={{ duration: reduced ? 0 : 0.12 }}
          className="border-ring/70 bg-background/85 pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-3xl border-2 border-dashed backdrop-blur-[2px]"
        >
          <span className="text-foreground flex items-center gap-2 text-sm font-medium">
            <HugeiconsIcon icon={Upload04Icon} strokeWidth={2} className="size-4" />
            {m.knowledge_drop_files()}
          </span>
        </motion.div>
      </div>
      <KnowledgeSourcesSection
        collectionId={collectionId}
        documents={syncedDocuments}
        onEdit={setSyncing}
      />
      {canEdit && syncing ? (
        <SourcePickerDialog
          key={syncing.sourceId ?? syncing.integrationId}
          collectionId={collectionId}
          target={syncing}
          open
          onOpenChange={(open) => !open && setSyncing(null)}
        />
      ) : null}
      {canEdit ? (
        <>
          <CollectionDialog open={renaming} onOpenChange={setRenaming} collection={collection} />
          <AccessDialog
            resource={{ kind: "collection", id: collectionId }}
            title={collection.name}
            open={sharing}
            onOpenChange={setSharing}
          />
          <NoteDialog
            key={note === null ? "closed" : note === "new" ? "new" : note.id}
            collectionId={collectionId}
            editing={note}
            onOpenChange={(open) => {
              if (!open) setNote(null);
            }}
          />
        </>
      ) : null}
    </Page>
  );
}
