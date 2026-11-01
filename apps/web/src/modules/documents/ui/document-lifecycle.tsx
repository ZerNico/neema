import {
  BubbleChatAddIcon,
  Delete02Icon,
  FolderAddIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { useSessionUser } from "~/modules/auth/client.ts";
import { referenceLabel, restoreReferences } from "~/modules/chat/references.ts";
import { projectsQuery } from "~/modules/projects/client/queries.ts";
import { projectCan } from "~/modules/projects/schema.ts";
import { m } from "~/paraglide/messages.js";
import { useConfirm } from "~/ui/confirm-context.ts";
import { toastError } from "~/ui/error-toast.ts";
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "~/ui/primitives/dropdown-menu";
import type { EditableDocument } from "../schema.ts";
import { copyDocumentToProject, deleteDocument } from "../server/document-functions.ts";

type Lifecycle = Pick<EditableDocument, "id" | "title" | "userId" | "projectId" | "canEdit">;

/** Lists showing the document; the sync event follows, this is only sooner. */
const refresh = (queryClient: ReturnType<typeof useQueryClient>, documentId: string) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: ["documents", documentId] }),
    queryClient.invalidateQueries({ queryKey: ["documents", "library"] }),
    queryClient.invalidateQueries({ queryKey: ["conversation"] }),
    queryClient.invalidateQueries({ queryKey: ["projects", "documents"] }),
  ]);

/**
 * Chat about it, share, copy into a project and delete. A person's document
 * is its owner's to change, though anyone reading it sees who else does; a
 * project's may be deleted by anyone who may edit it. `onShare` opens the
 * dialog, which outlives the menu.
 */
export function DocumentLifecycleItems({
  document,
  onShare,
}: {
  document: Lifecycle;
  onShare: () => void;
}) {
  const me = useSessionUser();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const personal = document.userId !== null;
  const mine = personal && document.userId === me?.id;
  // The menu mounts its items only while open, so this asks then.
  const projects = useQuery(projectsQuery);
  const targets = (projects.data ?? []).filter(
    (project) => projectCan.edit(project.role) && project.id !== document.projectId,
  );
  // The menu closes on the click, so the toast is what shows it working.
  const copy = useMutation({
    mutationFn: (project: { id: string; name: string }) =>
      copyDocumentToProject({ data: { documentId: document.id, projectId: project.id } }),
    onMutate: (project) => toast.loading(m.documents_copying({ project: project.name })),
    onSuccess: (made, project, pending) => {
      toast.success(m.documents_copy_done({ project: project.name }), {
        id: pending,
        action: {
          label: m.documents_copy_open(),
          onClick: () =>
            void navigate({
              to: "/projects/$projectId",
              params: { projectId: project.id },
              search: { document: made.id },
            }),
        },
      });
      return queryClient.invalidateQueries({ queryKey: ["projects", "documents", project.id] });
    },
    onError: (error, _project, pending) => {
      toast.dismiss(pending);
      toastError(m.documents_copy_failed(), error);
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteDocument({ data: { documentId: document.id } }),
    onSuccess: () => refresh(queryClient, document.id),
    onError: (error) => toastError(m.documents_delete_failed(), error),
  });
  return (
    <>
      <DropdownMenuItem
        onClick={() =>
          void navigate({
            to: "/",
            // A project's document is read in a chat of that project.
            search: document.projectId ? { project: document.projectId } : {},
            state: {
              chatPrefill: restoreReferences("", [
                { kind: "document", id: document.id, label: referenceLabel(document.title) },
              ]),
            },
          })
        }
      >
        <HugeiconsIcon icon={BubbleChatAddIcon} strokeWidth={2} />
        {m.documents_chat_about()}
      </DropdownMenuItem>
      {personal ? (
        <DropdownMenuItem onClick={onShare}>
          <HugeiconsIcon icon={UserGroupIcon} strokeWidth={2} />
          {/* Only the owner changes it; anyone else may see who has it. */}
          {mine ? m.documents_share() : m.documents_access()}
        </DropdownMenuItem>
      ) : null}
      {targets.length > 0 ? (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={copy.isPending}>
            <HugeiconsIcon icon={FolderAddIcon} strokeWidth={2} />
            {m.documents_copy_to_project()}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {targets.map((project) => (
              <DropdownMenuItem key={project.id} onClick={() => copy.mutate(project)}>
                {project.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : null}
      {mine || (!personal && document.canEdit) ? (
        <DropdownMenuItem
          variant="destructive"
          disabled={remove.isPending}
          onClick={() => {
            void confirm({
              title: m.documents_delete_title({ title: document.title }),
              description: personal
                ? m.documents_delete_description()
                : m.projects_documents_delete_description(),
              confirmLabel: m.documents_delete(),
            }).then((confirmed) => {
              if (confirmed) remove.mutate();
            });
          }}
        >
          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
          {m.documents_delete()}
        </DropdownMenuItem>
      ) : null}
    </>
  );
}
