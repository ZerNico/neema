import {
  BubbleChatIcon,
  Delete02Icon,
  File01Icon,
  FileAddIcon,
  Folder01Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";
import { uuidv7 } from "uuidv7";
import { chatModelsQuery } from "~/modules/chat/client/queries.ts";
import { resolveChatModel } from "~/modules/chat/client/selected-model.ts";
import { browserTimeZone } from "~/modules/chat/client/time-zone.ts";
import { sendMessage } from "~/modules/chat/server/functions.ts";
import type { DocumentAsk } from "~/modules/documents/ui/rich-editor/editor-hooks.ts";
import { relativeAgeLabel } from "~/modules/chat/ui/timestamps.ts";
import { projectDocumentsQuery } from "~/modules/documents/client/document-queries.ts";
import {
  createProjectDocument,
  deleteProjectDocument,
} from "~/modules/documents/server/document-functions.ts";
import { DocumentOwner, type DocumentOwnerHandle } from "~/modules/documents/ui/document-owner.tsx";
import { RenameDocumentDialog } from "~/modules/documents/ui/rename-document-dialog.tsx";
import { useDocumentPanel } from "~/modules/documents/ui/document-panel-context.ts";
import type { EditableDocument } from "~/modules/documents/schema.ts";
import { useConfirm } from "~/ui/confirm-context.ts";
import { toastError } from "~/ui/error-toast.ts";
import {
  EmptyState,
  ErrorState,
  FormActions,
  ListCard,
  ListRow,
  ListSkeleton,
  Page,
  Section,
} from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "~/ui/primitives/field";
import { RadioGroup, RadioGroupItem } from "~/ui/primitives/radio-group";
import { sheetLocale } from "@chat/sheet/locales";
import { createProjectSheet } from "~/modules/documents/sheet/server/sheet-functions.ts";
import { Input } from "~/ui/primitives/input";
import { Textarea } from "~/ui/primitives/textarea";
import { projectChatsQuery, projectQuery } from "../client/queries.ts";
import { PROJECT_LIMITS, projectCan, type ProjectDetail } from "../schema.ts";
import { deleteProject, updateProject } from "../server/functions.ts";
import { ProjectMembersDialog } from "./project-members-dialog.tsx";
import { ProjectFilesSection } from "./project-files-section.tsx";
import { ProjectMemorySection } from "./project-memory-section.tsx";
import { roleLabel } from "./role-labels.ts";

const notFound = (error: unknown) => error instanceof Error && /not found/i.test(error.message);

export function ProjectPage({ projectId }: { projectId: string }) {
  const project = useQuery(projectQuery(projectId));
  if (project.isError)
    return (
      <Page title="Project" rootPath="/projects" rootLabel="Projects">
        {notFound(project.error) ? (
          <EmptyState
            icon={Folder01Icon}
            title="This project is not available"
            description="It was deleted, or you are no longer a member."
            action={
              <Link to="/projects" className={buttonVariants({ size: "sm", variant: "outline" })}>
                All projects
              </Link>
            }
          />
        ) : (
          <ErrorState
            title="Could not load the project"
            onRetry={() => {
              void project.refetch();
            }}
          />
        )}
      </Page>
    );
  if (!project.data)
    return (
      <Page title="Project" rootPath="/projects" rootLabel="Projects">
        <ListSkeleton label="Loading project" />
      </Page>
    );
  return <LoadedProject project={project.data} />;
}

function LoadedProject({ project }: { project: ProjectDetail }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [members, setMembers] = useState(false);
  const [editing, setEditing] = useState(false);
  const editable = projectCan.edit(project.role);
  const remove = useMutation({
    mutationFn: () => deleteProject({ data: { projectId: project.id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      await navigate({ to: "/projects" });
    },
    onError: (error) => toastError("Could not delete the project.", error),
  });
  return (
    <Page
      title={project.name}
      description={project.description || undefined}
      backTo="/projects"
      backLabel="Projects"
      actions={
        <>
          {project.role === "owner" ? null : (
            <Badge variant="outline">{roleLabel[project.role]}</Badge>
          )}
          <Button size="sm" variant="outline" onClick={() => setMembers(true)}>
            <HugeiconsIcon icon={UserGroupIcon} strokeWidth={2} data-icon="inline-start" />
            Members
          </Button>
          <Link to="/" search={{ project: project.id }} className={buttonVariants({ size: "sm" })}>
            <HugeiconsIcon icon={BubbleChatIcon} strokeWidth={2} data-icon="inline-start" />
            New chat
          </Link>
          {editable ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button size="icon-sm" variant="ghost" aria-label="Project actions" />}
              >
                <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setEditing(true)}>
                  <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
                  Rename
                </DropdownMenuItem>
                {project.role === "owner" ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={remove.isPending}
                      onClick={() => {
                        void confirm({
                          title: `Delete “${project.name}”?`,
                          description:
                            "Its documents, files and memory are deleted for everyone. Chats in it become ordinary chats and keep their messages.",
                          confirmLabel: "Delete project",
                        }).then((confirmed) => {
                          if (confirmed) remove.mutate();
                        });
                      }}
                    >
                      <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                      Delete
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </>
      }
    >
      <InstructionsSection project={project} editable={editable} />
      <DocumentsSection project={project} editable={editable} />
      <ProjectFilesSection projectId={project.id} editable={editable} />
      <ProjectMemorySection projectId={project.id} editable={editable} />
      <ChatsSection projectId={project.id} />
      <ProjectMembersDialog project={project} open={members} onOpenChange={setMembers} />
      <RenameDialog project={project} open={editing} onOpenChange={setEditing} />
    </Page>
  );
}

function InstructionsSection({ project, editable }: { project: ProjectDetail; editable: boolean }) {
  const id = useId();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? project.instructions;
  const save = useMutation({
    mutationFn: () => updateProject({ data: { projectId: project.id, instructions: value } }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(projectQuery(project.id).queryKey, updated);
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: ["projects", "list"] });
    },
    onError: (error) => toastError("Could not save the instructions.", error),
  });
  return (
    <Section
      title="Instructions"
      description="Every chat in this project follows these, whoever starts it."
    >
      {editable ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <Field>
            <FieldLabel htmlFor={`${id}-instructions`} className="sr-only">
              Instructions
            </FieldLabel>
            <Textarea
              id={`${id}-instructions`}
              value={value}
              maxLength={PROJECT_LIMITS.instructions}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="How answers in this project should look: tone, audience, what to always keep in mind"
              className="min-h-32"
              disabled={save.isPending}
            />
          </Field>
          {draft !== null && draft !== project.instructions ? (
            <FormActions>
              <PendingButton type="submit" size="sm" pending={save.isPending}>
                Save instructions
              </PendingButton>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={save.isPending}
                onClick={() => setDraft(null)}
              >
                Discard
              </Button>
            </FormActions>
          ) : null}
        </form>
      ) : project.instructions ? (
        <p className="text-sm whitespace-pre-wrap">{project.instructions}</p>
      ) : (
        <p className="text-muted-foreground text-sm">No instructions yet.</p>
      )}
    </Section>
  );
}

function DocumentsSection({ project, editable }: { project: ProjectDetail; editable: boolean }) {
  const documents = useQuery(projectDocumentsQuery(project.id));
  const [creating, setCreating] = useState(false);
  // A document just made here opens once its row and connection exist.
  const [justCreated, setJustCreated] = useState<string | null>(null);
  const rows = documents.data ?? [];
  const owner = useRef<DocumentOwnerHandle>(null);
  const askInNewChat = useAskInNewChat(project.id, owner);
  return (
    <Section
      title="Documents"
      description="Shared by everyone in the project and edited live, by people and by the assistant."
      actions={
        editable ? (
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <HugeiconsIcon icon={FileAddIcon} strokeWidth={2} data-icon="inline-start" />
            New document
          </Button>
        ) : null
      }
    >
      {documents.isError ? (
        <ErrorState
          title="Could not load documents"
          onRetry={() => {
            void documents.refetch();
          }}
        />
      ) : !documents.data ? (
        <ListSkeleton label="Loading documents" />
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {editable
            ? "No documents yet. Start one here, or ask the assistant in a project chat."
            : "No documents yet."}
        </p>
      ) : (
        // The owner keeps each document's live controller mounted while the
        // page is open, so closing the panel never discards typing.
        <DocumentOwner
          ref={owner}
          documentIds={rows.map((row) => row.id)}
          onGone={() => undefined}
          onAsk={askInNewChat}
        >
          <ListCard>
            {rows.map((document) => (
              <ProjectDocumentRow
                key={document.id}
                document={document}
                editable={editable}
                openNow={document.id === justCreated}
                onOpened={() => setJustCreated(null)}
              />
            ))}
          </ListCard>
        </DocumentOwner>
      )}
      <NewDocumentDialog
        projectId={project.id}
        open={creating}
        onOpenChange={setCreating}
        onCreated={setJustCreated}
      />
    </Section>
  );
}

/**
 * A comment sent to the assistant from the project page, where no chat is
 * open: it starts a new chat in the project with the default model, about
 * that document and thread, and opens it.
 */
function useAskInNewChat(
  projectId: string,
  owner: RefObject<DocumentOwnerHandle | null>,
): DocumentAsk {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return async (request, asked) => {
    // The request names blocks, maybe one just planted: they must be stored first.
    if (!(await owner.current?.flush())) {
      toast.error("Resolve the changes in your document before continuing.");
      return false;
    }
    const model = resolveChatModel(await queryClient.ensureQueryData(chatModelsQuery), null);
    if (!model) return false;
    const result = await sendMessage({
      data: {
        conversation: { kind: "new", id: uuidv7(), mode: "chat", projectId },
        modelId: model.id,
        content: request,
        searchEnabled: false,
        researchEnabled: false,
        timeZone: browserTimeZone(),
        attachmentIds: [],
        openDocument: {
          id: asked.documentId,
          ...(asked.blocks.length ? { selected: [...asked.blocks] } : {}),
          ...(asked.thread ? { thread: asked.thread } : {}),
        },
      },
    });
    await queryClient.invalidateQueries({ queryKey: ["conversations"] });
    await navigate({
      to: "/chat/$conversationId",
      params: { conversationId: result.conversationId },
      state: { anchorNewTurn: true },
    });
    return true;
  };
}

function ProjectDocumentRow({
  document,
  editable,
  openNow,
  onOpened,
}: {
  document: EditableDocument;
  editable: boolean;
  openNow: boolean;
  onOpened: () => void;
}) {
  const { entry } = useDocumentPanel(document.id);
  const open = entry?.open;
  useEffect(() => {
    if (!openNow || !open) return;
    open();
    onOpened();
  }, [openNow, open, onOpened]);
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const remove = useMutation({
    mutationFn: () => deleteProjectDocument({ data: { documentId: document.id } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["projects", "documents"] }),
    onError: (error) => toastError("Could not delete the document.", error),
  });
  const detail = `Updated ${relativeAgeLabel(document.updatedAt)}`;
  return (
    <ListRow>
      <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-2xl">
        <HugeiconsIcon icon={File01Icon} strokeWidth={2} className="size-4" />
      </div>
      <button
        type="button"
        className="flex min-w-0 flex-1 flex-col text-left"
        aria-label={`Open document: ${entry?.title ?? document.title}`}
        aria-expanded={entry?.expanded ?? false}
        disabled={!entry?.open}
        onClick={() => entry?.open?.()}
      >
        <span className="truncate text-sm font-medium">{entry?.title ?? document.title}</span>
        <span className="text-muted-foreground truncate text-xs">{detail}</span>
      </button>
      {editable ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${document.title}`} />
            }
          >
            <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setRenaming(true)}>
              <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => {
                void confirm({
                  title: `Delete “${document.title}”?`,
                  description: "It is deleted for everyone in the project.",
                  confirmLabel: "Delete document",
                }).then((confirmed) => {
                  if (confirmed) remove.mutate();
                });
              }}
            >
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {editable ? (
        <RenameDocumentDialog document={document} open={renaming} onOpenChange={setRenaming} />
      ) : null}
    </ListRow>
  );
}

function NewDocumentDialog({
  projectId,
  open,
  onOpenChange,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (documentId: string) => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"text" | "sheet">("text");
  const save = useMutation({
    mutationFn: () =>
      kind === "sheet"
        ? createProjectSheet({
            data: {
              projectId,
              title: title.trim(),
              // A new sheet types and shows numbers as this person does, and NOW reads their clock.
              locale: sheetLocale(navigator.language).id,
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
          })
        : createProjectDocument({ data: { projectId, title: title.trim() } }),
    onSuccess: async (document) => {
      onCreated(document.id);
      await queryClient.invalidateQueries({ queryKey: ["projects", "documents", projectId] });
      onOpenChange(false);
      setTitle("");
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && save.isPending) return;
        if (!next) setTitle("");
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New document</DialogTitle>
          <DialogDescription>
            A blank document or sheet everyone in the project can edit.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim()) save.mutate();
          }}
        >
          <FieldGroup>
            <RadioGroup
              value={kind}
              onValueChange={(value) => setKind(value === "sheet" ? "sheet" : "text")}
              aria-label="Kind of document"
              className="grid-cols-2"
            >
              {(
                [
                  ["text", "Document", "Text to write and format"],
                  ["sheet", "Sheet", "Rows and columns with formulas"],
                ] as const
              ).map(([value, name, about]) => (
                <Field key={value} orientation="horizontal">
                  <RadioGroupItem value={value} id={`${id}-${value}`} disabled={save.isPending} />
                  <FieldLabel htmlFor={`${id}-${value}`}>
                    <span className="flex flex-col gap-0.5">
                      <span>{name}</span>
                      <span className="text-muted-foreground text-xs font-normal">{about}</span>
                    </span>
                  </FieldLabel>
                </Field>
              ))}
            </RadioGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-title`}>Title</FieldLabel>
              <Input
                id={`${id}-title`}
                value={title}
                maxLength={200}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={kind === "sheet" ? "Budget" : "Launch checklist"}
                disabled={save.isPending}
                autoFocus
              />
            </Field>
          </FieldGroup>
          {save.isError ? <FieldError>Could not create the document.</FieldError> : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={save.isPending} />}>
              Cancel
            </DialogClose>
            <PendingButton type="submit" pending={save.isPending} disabled={!title.trim()}>
              {kind === "sheet" ? "Create sheet" : "Create document"}
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ChatsSection({ projectId }: { projectId: string }) {
  const chats = useQuery(projectChatsQuery(projectId));
  const rows = chats.data ?? [];
  return (
    <Section
      title="Your chats"
      description="Only you see your chats here, even in a shared project."
    >
      {chats.isError ? (
        <ErrorState
          title="Could not load your chats"
          onRetry={() => {
            void chats.refetch();
          }}
        />
      ) : !chats.data ? (
        <ListSkeleton label="Loading chats" />
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No chats yet. Start one with New chat, or move an existing chat here from its menu.
        </p>
      ) : (
        <ListCard>
          {rows.map((chat) => (
            <ListRow key={chat.id}>
              <Link
                to="/chat/$conversationId"
                params={{ conversationId: chat.id }}
                className="flex min-w-0 flex-1 flex-col"
              >
                <span className="truncate text-sm font-medium">{chat.title ?? "New chat"}</span>
                <span className="text-muted-foreground truncate text-xs">
                  {relativeAgeLabel(chat.lastActivityAt)}
                </span>
              </Link>
            </ListRow>
          ))}
        </ListCard>
      )}
    </Section>
  );
}

function RenameDialog({
  project,
  open,
  onOpenChange,
}: {
  project: ProjectDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const save = useMutation({
    mutationFn: () =>
      updateProject({
        data: { projectId: project.id, name: name.trim(), description: description.trim() },
      }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(projectQuery(project.id).queryKey, updated);
      await queryClient.invalidateQueries({ queryKey: ["projects", "list"] });
      onOpenChange(false);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && save.isPending) return;
        if (next) {
          setName(project.name);
          setDescription(project.description);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename project</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) save.mutate();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
              <Input
                id={`${id}-name`}
                value={name}
                maxLength={PROJECT_LIMITS.name}
                onChange={(event) => setName(event.target.value)}
                disabled={save.isPending}
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-description`}>Description</FieldLabel>
              <Textarea
                id={`${id}-description`}
                value={description}
                maxLength={PROJECT_LIMITS.description}
                onChange={(event) => setDescription(event.target.value)}
                disabled={save.isPending}
              />
              <FieldDescription>Shown to everyone in the project.</FieldDescription>
            </Field>
          </FieldGroup>
          {save.isError ? <FieldError>Could not save the project.</FieldError> : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={save.isPending} />}>
              Cancel
            </DialogClose>
            <PendingButton type="submit" pending={save.isPending} disabled={!name.trim()}>
              Save
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
