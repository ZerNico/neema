import { useQueryClient } from "@tanstack/react-query";
import { m } from "~/paraglide/messages.js";
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
      title={m.documents_rename_title()}
      label={m.documents_rename_label()}
      initial={document.title}
      maxLength={DOCUMENT_LIMITS.title}
      submitLabel={m.common_rename()}
      failure={m.documents_rename_error()}
      onSubmit={async (title) => {
        const renamed = await renameDocument({ data: { documentId: document.id, title } });
        queryClient.setQueryData(["documents", document.id], renamed);
      }}
    />
  );
}
