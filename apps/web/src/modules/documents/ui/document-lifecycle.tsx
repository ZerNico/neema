import {
  Delete02Icon,
  FolderAddIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useSessionUser } from "~/modules/auth/client.ts";
import { useWritableChatProject } from "~/modules/projects/ui/writable-chat-project-context.ts";
import { m } from "~/paraglide/messages.js";
import { useConfirm } from "~/ui/confirm-context.ts";
import { toastError } from "~/ui/error-toast.ts";
import { DropdownMenuItem } from "~/ui/primitives/dropdown-menu";
import type { EditableDocument } from "../schema.ts";
import { deleteDocument, moveDocumentToProject } from "../server/document-functions.ts";

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
 * Share, move into the chat's project and delete. A person's document
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
  const project = useWritableChatProject();
  const move = useMutation({
    mutationFn: (projectId: string) =>
      moveDocumentToProject({ data: { documentId: document.id, projectId } }),
    onSuccess: () => {
      if (project) toast.success(m.documents_move_done({ project: project.name }));
      return refresh(queryClient, document.id);
    },
    onError: (error) => toastError(m.documents_move_failed(), error),
  });
  const remove = useMutation({
    mutationFn: () => deleteDocument({ data: { documentId: document.id } }),
    onSuccess: () => refresh(queryClient, document.id),
    onError: (error) => toastError(m.documents_delete_failed(), error),
  });
  const personal = document.userId !== null;
  const mine = personal && document.userId === me?.id;
  return (
    <>
      {personal ? (
        <DropdownMenuItem onClick={onShare}>
          <HugeiconsIcon icon={UserGroupIcon} strokeWidth={2} />
          {m.documents_share()}
        </DropdownMenuItem>
      ) : null}
      {mine && project ? (
        <DropdownMenuItem disabled={move.isPending} onClick={() => move.mutate(project.id)}>
          <HugeiconsIcon icon={FolderAddIcon} strokeWidth={2} />
          {m.documents_move_to_project({ project: project.name })}
        </DropdownMenuItem>
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
