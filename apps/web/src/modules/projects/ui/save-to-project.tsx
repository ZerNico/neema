import { FolderAddIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createContext, use, type ReactNode } from "react";
import { toast } from "sonner";
import { toastError } from "~/ui/error-toast.ts";
import { PendingButton } from "~/ui/pending-button.tsx";
import { buttonVariants } from "~/ui/primitives/button";
import { saveAttachmentToProject } from "../server/functions.ts";

/** The project of the chat on screen, when the reader may change its files. */
export const WritableChatProject = createContext<{ id: string; name: string } | null>(null);

export function WritableChatProjectProvider({
  project,
  children,
}: {
  project: { id: string; name: string } | null;
  children: ReactNode;
}) {
  return <WritableChatProject value={project}>{children}</WritableChatProject>;
}

export const useWritableChatProject = () => use(WritableChatProject);

/**
 * Preview actions for a stored chat file in a project chat: keep it with the
 * project, or open the original, which these actions replace.
 */
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
      toast.success(`Saved to ${project.name} as ${file.name}`);
      return queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (error) => toastError("Could not save the file to the project.", error),
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
        Save to project
      </PendingButton>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className={buttonVariants({ size: "sm", variant: "ghost" })}
      >
        Open original
      </a>
    </>
  );
}
