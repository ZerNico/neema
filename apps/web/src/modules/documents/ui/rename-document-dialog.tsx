import { useQueryClient } from "@tanstack/react-query";
import { NameDialog } from "~/ui/name-dialog.tsx";
import { DOCUMENT_LIMITS, type EditableDocument } from "../schema.ts";
import { renameDocument } from "../server/document-functions.ts";

/**
 * A new title for a document, by anyone who may edit it. The change reaches
 * every open card, list and panel through the document's sync event.
 */
export function RenameDocumentDialog({
  document,
  open,
  onOpenChange,
}: {
  document: Pick<EditableDocument, "id" | "title" | "conversationId" | "projectId">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  return (
    <NameDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Rename document"
      label="Title"
      initial={document.title}
      maxLength={DOCUMENT_LIMITS.title}
      submitLabel="Rename"
      failure="Could not rename the document."
      onSubmit={async (title) => {
        const renamed = await renameDocument({ data: { documentId: document.id, title } });
        queryClient.setQueryData(["documents", document.id], renamed);
      }}
    />
  );
}
