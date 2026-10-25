import { FolderAddIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode } from "react";
import { toast } from "sonner";
import { toastError } from "~/ui/error-toast.ts";
import { PendingButton } from "~/ui/pending-button.tsx";
import { buttonVariants } from "~/ui/primitives/button";
import { saveAttachmentToProject } from "../server/functions.ts";
import { WritableChatProject } from "./writable-chat-project-context.ts";

export function WritableChatProjectProvider({
  project,
  children,
}: {
  project: { id: string; name: string } | null;
  children: ReactNode;
}) {
  return <WritableChatProject value={project}>{children}</WritableChatProject>;
}

/**
 * Preview actions for a stored chat file in a project chat: keep it with the
 * project, or open the original, which these actions replace.
 */
import { m } from "~/paraglide/messages.js";

export function SaveToProjectActions({
  project,
  attachmentId,
  url,
}: {
  project: { id: string; name: string };
  attachmentId: string;
  url: string;
}) {
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: () => saveAttachmentToProject({ data: { projectId: project.id, attachmentId } }),
    onSuccess: (file) => {
      toast.success(m.projects_save_to_project_done({ project: project.name, file: file.name }));
      return queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (error) => toastError(m.projects_save_to_project_failed(), error),
  });
  return (
    <>
      <PendingButton
        size="sm"
        variant="outline"
        pending={save.isPending}
        onClick={() => save.mutate()}
      >
        <HugeiconsIcon icon={FolderAddIcon} strokeWidth={2} data-icon="inline-start" />
        {m.projects_save_to_project()}
      </PendingButton>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className={buttonVariants({ size: "sm", variant: "ghost" })}
      >
        {m.projects_open_original()}
      </a>
    </>
  );
}
