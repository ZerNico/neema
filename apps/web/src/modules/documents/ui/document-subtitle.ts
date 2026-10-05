import { relativeAgeLabel } from "~/modules/chat/ui/timestamps.ts";
import type { DocumentController as Controller } from "../client/use-document.ts";

export const documentSubtitle = (controller: Controller, userId?: string) => {
  const document = controller.document;
  if (!document) return "Document";
  const age = relativeAgeLabel(document.updatedAt);
  // Kept short: the panel header gives the title whatever this leaves. In a
  // project someone else's edit goes unnamed rather than crowding it out.
  const editor =
    document.lastEditedBy === "model"
      ? "by the assistant"
      : !document.projectId || !document.lastEditorUserId || document.lastEditorUserId === userId
        ? "by you"
        : null;
  return [
    // One word, so a shared document reads apart from this chat's own.
    document.projectId ? "Project" : null,
    document.canEdit ? null : "View only",
    ["Edited", editor, age].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(" · ");
};
