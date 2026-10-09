import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Button } from "~/ui/primitives/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
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
  const id = useId();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(document.title);
  const save = useMutation({
    mutationFn: () => renameDocument({ data: { documentId: document.id, title: title.trim() } }),
    onSuccess: async (renamed) => {
      queryClient.setQueryData(["documents", document.id], renamed);
      onOpenChange(false);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && save.isPending) return;
        if (next) {
          setTitle(document.title);
          save.reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename document</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim() && title.trim() !== document.title) save.mutate();
            else onOpenChange(false);
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-title`}>Title</FieldLabel>
              <Input
                id={`${id}-title`}
                value={title}
                maxLength={DOCUMENT_LIMITS.title}
                onChange={(event) => setTitle(event.target.value)}
                disabled={save.isPending}
                autoFocus
                onFocus={(event) => event.currentTarget.select()}
              />
            </Field>
          </FieldGroup>
          {save.isError ? <FieldError>Couldn’t rename the document.</FieldError> : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={save.isPending} />}>
              Cancel
            </DialogClose>
            <PendingButton type="submit" pending={save.isPending} disabled={!title.trim()}>
              Rename
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
