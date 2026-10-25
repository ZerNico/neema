import { relativeAgeLabel } from "~/modules/chat/ui/timestamps.ts";
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";
import type { DocumentController as Controller } from "../client/use-document.ts";

export const documentSubtitle = (controller: Controller, userId?: string) => {
  const document = controller.document;
  if (!document) return m.documents_subtitle_kind();
  const age = relativeAgeLabel(document.updatedAt, undefined, getLocale());
  // Kept short: the panel header gives the title whatever this leaves. In a
  // project someone else's edit goes unnamed rather than crowding it out.
  const edited =
    document.lastEditedBy === "model"
      ? m.documents_subtitle_edited_by_assistant({ age })
      : !document.projectId || !document.lastEditorUserId || document.lastEditorUserId === userId
        ? m.documents_subtitle_edited_by_you({ age })
        : m.documents_subtitle_edited({ age });
  return [
    // One word, so a shared document reads apart from this chat's own.
    document.projectId ? m.documents_subtitle_project() : null,
    document.canEdit ? null : m.documents_subtitle_view_only(),
    edited,
  ]
    .filter(Boolean)
    .join(" · ");
};
