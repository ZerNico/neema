import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { m } from "~/paraglide/messages.js";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Button } from "~/ui/primitives/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "~/ui/primitives/field";
import { OptionalMark } from "~/ui/form/form-fields.tsx";
import { Input } from "~/ui/primitives/input";
import { createDocument, createDocumentFromFile } from "../server/document-functions.ts";

/**
 * Starts a blank document, or one from a Word, Markdown or text file: in a
 * project, or the person's own outside one.
 */
export function NewDocumentDialog({
  projectId,
  open,
  onOpenChange,
  onCreated,
}: {
  projectId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (documentId: string) => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  // A text document may start from a Word, Markdown or text file instead of blank.
  const [file, setFile] = useState<File | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const reset = () => {
    setTitle("");
    setFile(null);
  };
  const save = useMutation({
    mutationFn: async () => {
      if (file) {
        const data = new FormData();
        data.set("file", file);
        if (projectId) data.set("projectId", projectId);
        data.set("title", title.trim());
        const imported = await createDocumentFromFile({ data });
        if (imported.dropped.length)
          toast(m.projects_documents_left_out({ parts: imported.dropped.join(", ") }));
        return imported.document;
      }
      return createDocument({
        data: { ...(projectId ? { projectId } : {}), title: title.trim() },
      });
    },
    onSuccess: async (document) => {
      onCreated(document.id);
      await queryClient.invalidateQueries({
        queryKey: projectId ? ["projects", "documents", projectId] : ["documents", "library"],
      });
      onOpenChange(false);
      reset();
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && save.isPending) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m.projects_documents_new()}</DialogTitle>
          {projectId ? (
            <DialogDescription>{m.projects_documents_new_description()}</DialogDescription>
          ) : null}
        </DialogHeader>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim()) save.mutate();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-file`}>
                {m.projects_documents_from_file()} <OptionalMark />
              </FieldLabel>
              <div className="flex items-center gap-2">
                <Input
                  ref={picker}
                  id={`${id}-file`}
                  type="file"
                  accept=".docx,.md,.markdown,.txt,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain"
                  disabled={save.isPending}
                  onChange={(event) => {
                    const picked = event.target.files?.[0] ?? null;
                    setFile(picked);
                    if (picked && !title.trim())
                      setTitle(picked.name.replace(/\.[^.]+$/, "").slice(0, 200));
                  }}
                />
                {file ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={save.isPending}
                    onClick={() => {
                      setFile(null);
                      if (picker.current) picker.current.value = "";
                    }}
                  >
                    {m.projects_documents_clear()}
                  </Button>
                ) : null}
              </div>
              <FieldDescription>{m.projects_documents_from_file_description()}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-title`}>{m.projects_documents_title_label()}</FieldLabel>
              <Input
                id={`${id}-title`}
                value={title}
                maxLength={200}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={m.projects_documents_title_placeholder()}
                disabled={save.isPending}
                autoFocus
              />
            </Field>
          </FieldGroup>
          {save.isError ? (
            <FieldError>
              {file && save.error instanceof Error && save.error.message
                ? save.error.message
                : m.projects_documents_create_failed()}
            </FieldError>
          ) : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={save.isPending} />}>
              {m.common_cancel()}
            </DialogClose>
            <PendingButton type="submit" pending={save.isPending} disabled={!title.trim()}>
              {m.projects_documents_create()}
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
