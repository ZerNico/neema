import { m } from "~/paraglide/messages.js";
import { File01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { use, useState, type ReactNode } from "react";
import type { Attachment } from "~/modules/attachments/schema.ts";
import { officePreview } from "~/modules/attachments/ui/office-preview.ts";
import { AttachmentPreviewDialog } from "~/modules/attachments/ui/attachment-preview.tsx";
import { useLocalFilePreview } from "~/modules/desktop/ui/use-local-file-preview.tsx";
import { useLocalFileConversation } from "~/modules/desktop/ui/local-file-context.ts";
import { inlineTagClassName } from "~/ui/inline-tag.ts";
import { focusRingClassName } from "~/ui/focus-ring.ts";
import { cn } from "~/ui/utils";
import {
  attachmentReferenceUrl,
  localFileName,
  parseFileReference,
  referenceAttachment,
  resolveLocalReference,
} from "../file-references.ts";
import { FileReferenceContext, FileReferenceMachine } from "./file-reference-context.ts";

function FileTag({ name, title, onClick }: { name: string; title: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      className={cn(
        inlineTagClassName("field"),
        focusRingClassName,
        "max-w-full cursor-pointer disabled:cursor-default disabled:opacity-60",
      )}
      title={title}
      aria-label={onClick ? m.chat_file_preview({ name }) : m.chat_file_unavailable_label({ name })}
      disabled={!onClick}
      onClick={onClick}
    >
      <HugeiconsIcon icon={File01Icon} strokeWidth={2} className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{name}</span>
    </button>
  );
}

function StoredReference({ attachment }: { attachment: Attachment }) {
  const [open, setOpen] = useState(false);
  const url = attachmentReferenceUrl(attachment.id);
  return (
    <>
      <FileTag
        name={attachment.fileName}
        title={attachment.fileName}
        onClick={() => setOpen(true)}
      />
      <AttachmentPreviewDialog
        target={{
          ...attachment,
          url,
          office: officePreview(attachment, { kind: "attachment", id: attachment.id }),
        }}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

function LocalReference({ path }: { path: string }) {
  const { aliases, machineId } = use(FileReferenceContext);
  const originMachineId = use(FileReferenceMachine);
  const local = useLocalFileConversation();
  const resolved = local
    ? resolveLocalReference({
        path,
        ...local,
        workspaceAncestors: aliases?.workspaceAncestors ?? [],
        machineId,
        originMachineId,
      })
    : null;
  const preview = useLocalFilePreview(resolved);
  return (
    <>
      <FileTag
        name={localFileName(path)}
        title={preview ? resolved! : m.chat_file_unavailable_here({ path })}
        {...(preview ? { onClick: preview.open } : {})}
      />
      {preview?.dialog}
    </>
  );
}

export function FileReferenceLink({ href, children }: { href: string; children: ReactNode }) {
  const { attachments, aliases } = use(FileReferenceContext);
  const reference = parseFileReference(href);
  if (reference?.kind === "local")
    return <LocalReference key={reference.path} path={reference.path} />;
  const attachment =
    reference?.kind === "attachment"
      ? referenceAttachment(reference.id, attachments, aliases)
      : undefined;
  if (attachment) return <StoredReference key={attachment.id} attachment={attachment} />;
  return (
    <span title={m.chat_file_unavailable()} aria-disabled="true">
      {children}
    </span>
  );
}
