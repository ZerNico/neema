import { useQuery } from "@tanstack/react-query";
import type { Editor, JSONContent } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "~/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { cn } from "~/ui/utils";
import { getDocumentVersion, getDocumentVersions } from "../../server/document-functions.ts";
import type { DocumentVersion } from "../../server/versions.ts";
import { browserEditorExtensions } from "./editor-extensions.ts";
import { restoreVersion } from "./version-restore.ts";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

const label = (version: DocumentVersion) =>
  version.author === null
    ? "Earliest kept version"
    : version.author.kind === "assistant"
      ? "Assistant"
      : version.author.name;

/**
 * The document's versions, newest first, and the chosen one shown as it was,
 * drawn by the editor itself so formulas, footnotes and pictures look as they
 * did. Restoring writes it back as a new edit; nothing is lost.
 */
export function VersionHistoryDialog({
  editor,
  documentId,
  open,
  onOpenChange,
}: {
  editor: Editor;
  documentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const versions = useQuery({
    queryKey: ["documents", "versions", documentId],
    queryFn: () => getDocumentVersions({ data: { documentId } }),
    enabled: open,
    staleTime: 0,
  });
  const list = versions.data ?? [];
  const [chosen, setChosen] = useState<number | null>(null);
  // The newest is the document as it is; a choice starts from the one before it.
  const selected = chosen ?? list[1]?.revision ?? list[0]?.revision ?? null;
  const version = useQuery({
    queryKey: ["documents", "version", documentId, selected],
    queryFn: async () => {
      const text = await getDocumentVersion({ data: { documentId, revision: selected! } });
      return text === null ? null : (JSON.parse(text) as JSONContent);
    },
    enabled: open && selected !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const current = selected !== null && selected === list[0]?.revision;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription>
            Versions go back as far as the document keeps its edits.
          </DialogDescription>
        </DialogHeader>
        <div className="flex h-[60vh] min-h-0 gap-4">
          <div className="min-w-0 flex-1 overflow-y-auto rounded-xl border px-4 py-3">
            {version.data ? (
              <VersionPreview key={selected} json={version.data} />
            ) : (
              <p className="text-muted-foreground text-sm">
                {version.isError ? "This version is no longer kept" : "Loading…"}
              </p>
            )}
          </div>
          <ul aria-label="Versions" className="w-60 shrink-0 overflow-y-auto">
            {list.map((each, index) => (
              <li key={each.revision}>
                <button
                  type="button"
                  aria-current={each.revision === selected ? "true" : undefined}
                  className={cn(
                    "hover:bg-muted flex w-full flex-col items-start rounded-lg px-3 py-2 text-left",
                    each.revision === selected && "bg-muted",
                  )}
                  onClick={() => setChosen(each.revision)}
                >
                  <span className="text-sm font-medium">
                    {index === 0 ? "Current version" : when.format(new Date(each.at))}
                  </span>
                  <span className="text-muted-foreground text-xs">{label(each)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            disabled={!version.data || current}
            onClick={() => {
              if (!version.data) return;
              restoreVersion(editor, version.data);
              onOpenChange(false);
              toast.success("Version restored", { description: "Undo takes it back." });
            }}
          >
            Restore this version
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A version drawn read-only by the editor's own extensions. */
function VersionPreview({ json }: { json: JSONContent }) {
  const preview = useEditor({
    extensions: browserEditorExtensions,
    // Named apart from the document itself, which stays open behind the dialog.
    editorProps: { attributes: { class: "rich-editor", "aria-label": "Version preview" } },
    content: json,
    editable: false,
    immediatelyRender: true,
  });
  return <EditorContent editor={preview} />;
}
