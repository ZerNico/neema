import { File01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { createContext, use, useState, type ReactNode } from "react";
import type { Attachment } from "~/modules/attachments/schema.ts";
import { AttachmentPreviewDialog } from "~/modules/attachments/ui/attachment-preview.tsx";
import {
  useLocalFileConversation,
  useLocalFilePreview,
} from "~/modules/desktop/ui/local-file-preview.tsx";
import { inlineTagClassName } from "~/ui/inline-tag.ts";
import { focusRingClassName } from "~/ui/focus-ring.ts";
import { cn } from "~/ui/utils";
import type { FileReferenceAliases } from "../file-reference-aliases.ts";
import {
  attachmentReferenceUrl,
  localFileName,
  parseFileReference,
  referenceAttachment,
  resolveLocalReference,
} from "../file-references.ts";

export const FileReferenceContext = createContext<{
  attachments: ReadonlyMap<string, Attachment>;
  aliases: FileReferenceAliases | null;
  machineId: string | null;
}>({ attachments: new Map(), aliases: null, machineId: null });

export const FileReferenceMachine = createContext<string | null>(null);

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
      aria-label={`${onClick ? "Preview" : "Unavailable file:"} ${name}`}
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
      <AttachmentPreviewDialog target={{ ...attachment, url }} open={open} onOpenChange={setOpen} />
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
        title={preview ? resolved! : `${path} · Unavailable on this computer`}
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
    <span title="This file is unavailable" aria-disabled="true">
      {children}
    </span>
  );
}
