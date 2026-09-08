import { DocumentSourcePanel } from "./document-source-panel.tsx";
import { useDetailPanel } from "~/ui/detail-panel.tsx";
import {
  Alert02Icon,
  Delete02Icon,
  Download04Icon,
  File01Icon,
  FolderLibraryIcon,
  MoreHorizontalIcon,
  NoteIcon,
  PencilEdit02Icon,
  RefreshIcon,
  Share01Icon,
  Upload04Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { knowledgeCollectionQuery } from "../client/queries.ts";
import { KNOWLEDGE_LIMITS, type KnowledgeDocument } from "../schema.ts";
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
import { ShareDialog } from "~/modules/sharing/ui/share-dialog.tsx";
import { useConfirm } from "~/ui/confirm.tsx";
import { useAppForm } from "~/ui/form/app-form.tsx";
import { EmptyState, ErrorState, ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button, buttonVariants } from "~/ui/primitives/button";
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
import { Spinner } from "~/ui/primitives/spinner";
import { useAppReducedMotion } from "~/ui/motion.tsx";
import * as m from "motion/react-m";
import { cn } from "~/ui/utils";

const NoteForm = Schema.Struct({
  title: Schema.String.check(
    Schema.isMinLength(1, { message: "Enter a title." }),
    Schema.isMaxLength(KNOWLEDGE_LIMITS.maxNameLength, { message: "Keep the title short." }),
  ),
  content: Schema.String.check(
    Schema.isMinLength(1, { message: "Enter the note." }),
    Schema.isMaxLength(KNOWLEDGE_LIMITS.maxNoteChars, {
      message: `Notes hold up to ${KNOWLEDGE_LIMITS.maxNoteChars.toLocaleString()} characters.`,
    }),
  ),
});

const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

const statusBadge = (document: KnowledgeDocument) => {
  if (document.status === "failed") return <Badge variant="destructive">Failed</Badge>;
  if (document.status !== "ready") return <Badge variant="secondary">Indexing</Badge>;
  if (document.replacement)
    return (
      <Badge variant={document.replacement.status === "failed" ? "destructive" : "secondary"}>
        {document.replacement.status === "failed" ? "Replacement failed" : "Replacing"}
      </Badge>
    );
  if (document.semanticStatus === "failed") return <Badge variant="outline">Keyword only</Badge>;
  if (
    document.semanticStatus === "needs_reindex" ||
    document.semanticStatus === "queued" ||
    document.semanticStatus === "running"
  )
    return <Badge variant="outline">Embedding</Badge>;
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
  const form = useAppForm({
    defaultValues: { title: source?.title ?? "", content: "" },
    validators: { onSubmit: Schema.toStandardSchemaV1(NoteForm) },
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
        toast.error(message(error, "Could not save the note."));
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
          <DialogTitle>{editing === "new" ? "Add note" : "Replace note"}</DialogTitle>
          <DialogDescription>
            {editing === "new"
              ? "Notes are indexed like uploaded documents."
              : "The current text stays readable until the new version is ready. Existing citations keep pointing at the version they cited."}
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
            {(field) => <field.TextField label="Title" placeholder="Refund policy" />}
          </form.AppField>
          {current.isError ? (
            <p className="text-destructive text-sm" role="alert">
              Could not load the current text. Close and try again.
            </p>
          ) : null}
          <form.AppField name="content">
            {(field) => (
              <field.TextareaField
                label="Note"
                rows={10}
                disabled={loading}
                {...(loading ? { description: "Loading the current text…" } : {})}
              />
            )}
          </form.AppField>
          <form.AppForm>
            <DialogFooter>
              <form.Subscribe selector={(state) => state.isSubmitting}>
                {(isSubmitting) => (
                  <DialogClose render={<Button variant="outline" disabled={isSubmitting} />}>
                    Cancel
                  </DialogClose>
                )}
              </form.Subscribe>
              {/* Submitting before the text loads would replace it with a blank. */}
              <form.SubmitButton disabled={loading || current.isError}>
                {editing === "new" ? "Add note" : "Replace note"}
              </form.SubmitButton>
            </DialogFooter>
          </form.AppForm>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CollectionPage({ collectionId }: { collectionId: string }) {
  const queryClient = useQueryClient();
  const panel = useDetailPanel();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const detail = useQuery(knowledgeCollectionQuery(collectionId));
  const [renaming, setRenaming] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [note, setNote] = useState<"new" | KnowledgeDocument | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const replacing = useRef<string | null>(null);
  // Same depth-counted drag tracking as the composer: dragenter/dragleave fire
  // for every child, so a counter keeps the highlight from flickering.
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const reduced = useAppReducedMotion();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["knowledge"] });

  const upload = useMutation({
    mutationFn: async (input: { file: File; documentId: string | null }) => {
      const body = new FormData();
      body.set("collectionId", collectionId);
      body.set(
        "title",
        input.file.name.replace(/\.[^.]+$/, "").slice(0, KNOWLEDGE_LIMITS.maxNameLength) ||
          "Document",
      );
      if (input.documentId) body.set("documentId", input.documentId);
      body.set("file", input.file);
      return uploadKnowledgeDocument({ data: body });
    },
    onSuccess: invalidate,
    onError: (error) => toast.error(message(error, "Could not upload the document.")),
  });
  // A drop can carry several files; each is its own upload with its own
  // outcome, so one bad file does not swallow the rest.
  const uploadMany = (files: Iterable<File>) => {
    for (const file of files) upload.mutate({ file, documentId: null });
  };
  const remove = useMutation({
    mutationFn: (documentId: string) => deleteKnowledgeDocument({ data: { documentId } }),
    onSuccess: invalidate,
    onError: () => toast.error("Could not delete the document."),
  });
  const retry = useMutation({
    mutationFn: (documentId: string) => retryKnowledgeDocument({ data: { documentId } }),
    onSuccess: invalidate,
    onError: (error) => toast.error(message(error, "Could not retry indexing.")),
  });
  const rebuild = useMutation({
    mutationFn: () => rebuildKnowledgeIndex({ data: { collectionId } }),
    onSuccess: async ({ reextracted, reembedded }) => {
      await invalidate();
      const total = reextracted + reembedded;
      toast.success(
        total === 0
          ? "Everything is already up to date."
          : `Rebuilding ${total} ${total === 1 ? "document" : "documents"} in the background. Search keeps working meanwhile.`,
      );
    },
    onError: (error) => toast.error(message(error, "Could not rebuild the index.")),
  });
  const removeCollection = useMutation({
    mutationFn: () => deleteKnowledgeCollection({ data: { collectionId } }),
    onSuccess: async () => {
      await invalidate();
      await navigate({ to: "/knowledge" });
    },
    onError: () => toast.error("Could not delete the collection."),
  });

  if (detail.isError)
    return (
      <Page title="Collection" backTo="/knowledge" backLabel="Knowledge">
        <ErrorState
          title="Could not load this collection"
          description="It may have been deleted, or you no longer have access."
          onRetry={() => {
            void detail.refetch();
          }}
        />
      </Page>
    );
  if (!detail.data) return null;
  const { collection, documents } = detail.data;
  const canEdit = collection.canEdit;
  const full = documents.length >= KNOWLEDGE_LIMITS.maxDocumentsPerCollection;
  const pickFile = (documentId: string | null) => {
    replacing.current = documentId;
    fileInput.current?.click();
  };
  const acceptDrop = (event: React.DragEvent) =>
    canEdit && !full && event.dataTransfer.types.includes("Files");
  const dropHandlers = {
    onDragEnter: (event: React.DragEvent) => {
      if (!acceptDrop(event)) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    },
    onDragOver: (event: React.DragEvent) => {
      if (!acceptDrop(event)) return;
      event.preventDefault();
    },
    onDragLeave: (event: React.DragEvent) => {
      if (!acceptDrop(event)) return;
      dragDepth.current -= 1;
      if (dragDepth.current <= 0) {
        dragDepth.current = 0;
        setDragging(false);
      }
    },
    onDrop: (event: React.DragEvent) => {
      if (!acceptDrop(event)) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      uploadMany(event.dataTransfer.files);
    },
  };

  return (
    <Page
      title={collection.name}
      description={
        collection.description ||
        (collection.ownerName ? `Shared by ${collection.ownerName}. Read and use only.` : undefined)
      }
      backTo="/knowledge"
      backLabel="Knowledge"
      actions={
        canEdit ? (
          <>
            <Button size="sm" variant="outline" onClick={() => setSharing(true)}>
              <HugeiconsIcon icon={Share01Icon} strokeWidth={2} data-icon="inline-start" />
              Share
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button size="icon-sm" variant="ghost" aria-label="Collection actions" />}
              >
                <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setRenaming(true)}>
                  <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => rebuild.mutate()} disabled={rebuild.isPending}>
                  <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
                  Rebuild index
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => {
                    void confirm({
                      title: "Delete this collection?",
                      description:
                        "Every document and note in it is removed. Chats that cited them will show those sources as unavailable.",
                      confirmLabel: "Delete collection",
                    }).then((confirmed) => {
                      if (confirmed) removeCollection.mutate();
                    });
                  }}
                >
                  <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                  Delete
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
          title="Documents"
          description={`${documents.length} of ${KNOWLEDGE_LIMITS.maxDocumentsPerCollection}`}
          actions={
            canEdit ? (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  accept=".pdf,.txt,.md,.markdown,text/plain,text/markdown,application/pdf"
                  className="hidden"
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
                <Button size="sm" variant="outline" onClick={() => setNote("new")} disabled={full}>
                  <HugeiconsIcon icon={NoteIcon} strokeWidth={2} data-icon="inline-start" />
                  Add note
                </Button>
                <Button
                  size="sm"
                  onClick={() => pickFile(null)}
                  disabled={full || upload.isPending}
                  aria-busy={upload.isPending || undefined}
                >
                  {upload.isPending ? (
                    <Spinner data-icon="inline-start" aria-hidden />
                  ) : (
                    <HugeiconsIcon icon={Upload04Icon} strokeWidth={2} data-icon="inline-start" />
                  )}
                  Upload
                </Button>
              </>
            ) : undefined
          }
        >
          {documents.length === 0 ? (
            <EmptyState
              icon={FolderLibraryIcon}
              title="No documents yet"
              description={
                canEdit
                  ? "Upload PDF, text or Markdown files, or add a note. Indexing runs in the background."
                  : "The owner has not added anything yet."
              }
            />
          ) : (
            <ListCard>
              {documents.map((document) => (
                <ListRow key={document.id}>
                  <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-2xl">
                    <HugeiconsIcon
                      icon={document.kind === "note" ? NoteIcon : File01Icon}
                      strokeWidth={2}
                      className="size-4"
                    />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{document.title}</span>
                    <span className="text-muted-foreground truncate text-xs">
                      {document.error ??
                        document.replacement?.error ??
                        [
                          document.fileName,
                          document.pageCount ? `${document.pageCount} pages` : null,
                          document.charCount
                            ? `${document.charCount.toLocaleString()} characters`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                    </span>
                  </div>
                  {statusBadge(document)}
                  {document.status === "failed" || document.replacement?.status === "failed" ? (
                    <HugeiconsIcon
                      icon={Alert02Icon}
                      strokeWidth={2}
                      className="text-warning size-4 shrink-0"
                      aria-hidden
                    />
                  ) : null}
                  {document.versionId && document.kind === "file" ? (
                    <a
                      href={`/api/knowledge/${encodeURIComponent(collectionId)}/${encodeURIComponent(document.id)}/${encodeURIComponent(document.versionId)}`}
                      className={buttonVariants({ size: "icon-sm", variant: "ghost" })}
                      aria-label={`Download ${document.title}`}
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
                      Read note
                    </Button>
                  ) : null}
                  {canEdit ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Actions for ${document.title}`}
                          />
                        }
                      >
                        <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {document.status === "failed" ||
                        document.replacement?.status === "failed" ? (
                          <DropdownMenuItem
                            onClick={() => retry.mutate(document.id)}
                            disabled={retry.isPending}
                          >
                            <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
                            Retry indexing
                          </DropdownMenuItem>
                        ) : null}
                        {document.kind === "note" ? (
                          <DropdownMenuItem onClick={() => setNote(document)}>
                            <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
                            Replace note
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            onClick={() => pickFile(document.id)}
                            disabled={upload.isPending}
                          >
                            <HugeiconsIcon icon={Upload04Icon} strokeWidth={2} />
                            Replace file
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => {
                            void confirm({
                              title: `Delete “${document.title}”?`,
                              description:
                                "Chats that cited it will show the source as unavailable. This cannot be undone.",
                              confirmLabel: "Delete document",
                            }).then((confirmed) => {
                              if (confirmed) remove.mutate(document.id);
                            });
                          }}
                        >
                          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </ListRow>
              ))}
            </ListCard>
          )}
        </Section>
        <m.div
          aria-hidden={!dragging}
          inert
          initial={false}
          animate={{ opacity: dragging ? 1 : 0 }}
          transition={{ duration: reduced ? 0 : 0.12 }}
          className="border-ring/70 bg-background/85 pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-3xl border-2 border-dashed backdrop-blur-[2px]"
        >
          <span className="text-foreground flex items-center gap-2 text-sm font-medium">
            <HugeiconsIcon icon={Upload04Icon} strokeWidth={2} className="size-4" />
            Drop files to add them
          </span>
        </m.div>
      </div>
      {canEdit ? (
        <>
          <CollectionDialog open={renaming} onOpenChange={setRenaming} collection={collection} />
          <ShareDialog
            resource={{ kind: "collection", id: collectionId }}
            title={collection.name}
            open={sharing}
            onOpenChange={setSharing}
            href={`/knowledge/${collectionId}`}
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
