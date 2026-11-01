import { NameDialog } from "~/ui/name-dialog.tsx";
import { ProjectDescriptionField } from "./project-description-field.tsx";
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
import { DocumentLifecycleItems } from "~/modules/documents/ui/document-lifecycle.tsx";
import { NewDocumentDialog } from "~/modules/documents/ui/new-document-dialog.tsx";
import { DocumentOwner, type DocumentOwnerHandle } from "~/modules/documents/ui/document-owner.tsx";
import { RenameDocumentDialog } from "~/modules/documents/ui/rename-document-dialog.tsx";
import { useDocumentPanel } from "~/modules/documents/ui/document-panel-context.ts";
import type { EditableDocument } from "~/modules/documents/schema.ts";
import { useConfirm } from "~/ui/confirm-context.ts";
import { AlreadyTold, toastError } from "~/ui/error-toast.ts";
import { m } from "~/paraglide/messages.js";
import { formatLocale } from "~/i18n/formats.ts";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Field, FieldLabel } from "~/ui/primitives/field";
import { Textarea } from "~/ui/primitives/textarea";
import { projectChatsQuery, projectQuery } from "../client/queries.ts";
import { PROJECT_LIMITS, projectCan, type ProjectDetail } from "../schema.ts";
import { deleteProject, updateProject } from "../server/functions.ts";
import { ProjectMembersDialog } from "./project-members-dialog.tsx";
import { ProjectFilesSection } from "./project-files-section.tsx";
import { ProjectMemorySection } from "./project-memory-section.tsx";
import { roleLabel } from "./role-labels.ts";

const notFound = (error: unknown) => error instanceof Error && /not found/i.test(error.message);

export function ProjectPage({
  projectId,
  openDocument = null,
}: {
  projectId: string;
  /** A document to open once its row is there. */
  openDocument?: string | null;
}) {
  const project = useQuery(projectQuery(projectId));
  if (project.isError)
    return (
      <Page title={m.projects_page_title()} rootPath="/projects" rootLabel={m.projects_title()}>
        {notFound(project.error) ? (
          <EmptyState
            icon={Folder01Icon}
            title={m.projects_page_unavailable()}
            description={m.projects_page_unavailable_description()}
            action={
              <Link to="/projects" className={buttonVariants({ size: "sm", variant: "outline" })}>
                {m.projects_page_all()}
              </Link>
            }
          />
        ) : (
          <ErrorState
            title={m.projects_page_load_failed()}
            onRetry={() => {
              void project.refetch();
            }}
          />
        )}
      </Page>
    );
  if (!project.data)
    return (
      <Page title={m.projects_page_title()} rootPath="/projects" rootLabel={m.projects_title()}>
        <ListSkeleton label={m.projects_page_loading()} />
      </Page>
    );
  return <LoadedProject project={project.data} openDocument={openDocument} />;
}

function LoadedProject({
  project,
  openDocument,
}: {
  project: ProjectDetail;
  openDocument: string | null;
}) {
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
    onError: (error) => toastError(m.projects_page_delete_failed(), error),
  });
  return (
    <Page
      title={project.name}
      description={project.description || undefined}
      backTo="/projects"
      backLabel={m.projects_title()}
      actions={
        <>
          {project.role === "owner" ? null : (
            <Badge variant="outline">{roleLabel[project.role]()}</Badge>
          )}
          <Button size="sm" variant="outline" onClick={() => setMembers(true)}>
            <HugeiconsIcon icon={UserGroupIcon} strokeWidth={2} data-icon="inline-start" />
            {m.projects_page_members()}
          </Button>
          <Link to="/" search={{ project: project.id }} className={buttonVariants({ size: "sm" })}>
            <HugeiconsIcon icon={BubbleChatIcon} strokeWidth={2} data-icon="inline-start" />
            {m.projects_page_new_chat()}
          </Link>
          {editable ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button size="icon-sm" variant="ghost" aria-label={m.projects_page_actions()} />
                }
              >
                <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setEditing(true)}>
                  <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
                  {m.common_rename()}
                </DropdownMenuItem>
                {project.role === "owner" ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={remove.isPending}
                      onClick={() => {
                        void confirm({
                          title: m.projects_page_delete_title({ name: project.name }),
                          description: m.projects_page_delete_description(),
                          confirmLabel: m.projects_page_delete(),
                        }).then((confirmed) => {
                          if (confirmed) remove.mutate();
                        });
                      }}
                    >
                      <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                      {m.common_delete()}
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
      <DocumentsSection project={project} editable={editable} openFirst={openDocument} />
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
    onError: (error) => toastError(m.projects_instructions_save_failed(), error),
  });
  return (
    <Section
      title={m.projects_instructions_title()}
      description={m.projects_instructions_description()}
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
              {m.projects_instructions_title()}
            </FieldLabel>
            <Textarea
              id={`${id}-instructions`}
              value={value}
              maxLength={PROJECT_LIMITS.instructions}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={m.projects_instructions_placeholder()}
              className="min-h-32"
              disabled={save.isPending}
            />
          </Field>
          {draft !== null && draft !== project.instructions ? (
            <FormActions>
              <PendingButton type="submit" size="sm" pending={save.isPending}>
                {m.projects_instructions_save()}
              </PendingButton>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={save.isPending}
                onClick={() => setDraft(null)}
              >
                {m.projects_instructions_discard()}
              </Button>
            </FormActions>
          ) : null}
        </form>
      ) : project.instructions ? (
        <p className="text-sm whitespace-pre-wrap">{project.instructions}</p>
      ) : (
        <p className="text-muted-foreground text-sm">{m.projects_instructions_empty()}</p>
      )}
    </Section>
  );
}

function DocumentsSection({
  project,
  editable,
  openFirst,
}: {
  project: ProjectDetail;
  editable: boolean;
  openFirst: string | null;
}) {
  const documents = useQuery(projectDocumentsQuery(project.id));
  const [creating, setCreating] = useState(false);
  // A document just made, here or as a copy elsewhere, opens once its row and connection exist.
  const [justCreated, setJustCreated] = useState<string | null>(openFirst);
  const rows = documents.data ?? [];
  const owner = useRef<DocumentOwnerHandle>(null);
  const askInNewChat = useAskInNewChat(project.id, owner);
  return (
    <Section
      title={m.projects_documents_title()}
      description={m.projects_documents_description()}
      actions={
        editable ? (
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <HugeiconsIcon icon={FileAddIcon} strokeWidth={2} data-icon="inline-start" />
            {m.projects_documents_new()}
          </Button>
        ) : null
      }
    >
      {documents.isError ? (
        <ErrorState
          title={m.projects_documents_load_failed()}
          onRetry={() => {
            void documents.refetch();
          }}
        />
      ) : !documents.data ? (
        <ListSkeleton label={m.projects_documents_loading()} />
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {editable ? m.projects_documents_empty_editable() : m.projects_documents_empty()}
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
      toast.error(m.projects_documents_resolve_first());
      return false;
    }
    const model = resolveChatModel(await queryClient.ensureQueryData(chatModelsQuery), null);
    if (!model) return false;
    // Refused, it says why here, and the caller then knows not to say it again.
    const result = await sendMessage({
      data: {
        conversation: { kind: "new", id: uuidv7(), projectId },
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
    }).catch((error: unknown) => {
      toastError(m.projects_documents_ask_failed(), error);
      void queryClient.invalidateQueries({ queryKey: chatModelsQuery.queryKey });
      throw new AlreadyTold("ask refused");
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
  const [renaming, setRenaming] = useState(false);
  const detail = m.projects_documents_updated({
    age: relativeAgeLabel(document.updatedAt, undefined, formatLocale()),
  });
  return (
    <ListRow>
      <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-2xl">
        <HugeiconsIcon icon={File01Icon} strokeWidth={2} className="size-4" />
      </div>
      <button
        type="button"
        className="flex min-w-0 flex-1 flex-col text-left"
        aria-label={m.projects_documents_open({ title: entry?.title ?? document.title })}
        aria-expanded={entry?.expanded ?? false}
        disabled={!entry?.open}
        onClick={() => entry?.open?.()}
      >
        <span className="truncate text-sm font-medium">{entry?.title ?? document.title}</span>
        <span className="text-muted-foreground truncate text-xs">{detail}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={m.projects_documents_actions({ title: document.title })}
            />
          }
        >
          <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {editable ? (
            <DropdownMenuItem onClick={() => setRenaming(true)}>
              <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
              {m.common_rename()}
            </DropdownMenuItem>
          ) : null}
          {/* A project's document is shared by its project, so there is nothing to share here. */}
          <DocumentLifecycleItems document={document} onShare={() => undefined} />
        </DropdownMenuContent>
      </DropdownMenu>
      {editable ? (
        <RenameDocumentDialog document={document} open={renaming} onOpenChange={setRenaming} />
      ) : null}
    </ListRow>
  );
}

function ChatsSection({ projectId }: { projectId: string }) {
  const chats = useQuery(projectChatsQuery(projectId));
  const rows = chats.data ?? [];
  return (
    <Section title={m.projects_chats_title()} description={m.projects_chats_description()}>
      {chats.isError ? (
        <ErrorState
          title={m.projects_chats_load_failed()}
          onRetry={() => {
            void chats.refetch();
          }}
        />
      ) : !chats.data ? (
        <ListSkeleton label={m.projects_chats_loading()} />
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{m.projects_chats_empty()}</p>
      ) : (
        <ListCard>
          {rows.map((chat) => (
            <ListRow key={chat.id}>
              <Link
                to="/chat/$conversationId"
                params={{ conversationId: chat.id }}
                className="flex min-w-0 flex-1 flex-col"
              >
                <span className="truncate text-sm font-medium">
                  {chat.title ?? m.projects_page_new_chat()}
                </span>
                <span className="text-muted-foreground truncate text-xs">
                  {relativeAgeLabel(chat.lastActivityAt, undefined, formatLocale())}
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
  const queryClient = useQueryClient();
  const [description, setDescription] = useState(project.description);
  return (
    <NameDialog
      open={open}
      onOpenChange={(next) => {
        if (next) setDescription(project.description);
        onOpenChange(next);
      }}
      title={m.projects_rename_title()}
      initial={project.name}
      maxLength={PROJECT_LIMITS.name}
      submitLabel={m.common_save()}
      failure={m.projects_rename_failed()}
      changed={description.trim() !== project.description}
      onSubmit={async (name) => {
        const updated = await updateProject({
          data: { projectId: project.id, name, description: description.trim() },
        });
        queryClient.setQueryData(projectQuery(project.id).queryKey, updated);
        await queryClient.invalidateQueries({ queryKey: ["projects", "list"] });
      }}
      renderExtra={(pending) => (
        <ProjectDescriptionField
          value={description}
          onChange={setDescription}
          pending={pending}
          hint={m.projects_rename_hint()}
        />
      )}
    />
  );
}
