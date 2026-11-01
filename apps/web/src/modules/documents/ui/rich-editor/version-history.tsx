import { m } from "~/paraglide/messages.js";
import { formatLocale } from "~/i18n/formats.ts";
import { PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Editor, JSONContent } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { toastError } from "~/ui/error-toast.ts";
import { Button } from "~/ui/primitives/button";
import { Field, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { Switch } from "~/ui/primitives/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { cn } from "~/ui/utils";
import {
  getDocumentVersion,
  getDocumentVersions,
  nameDocumentVersion,
} from "../../server/document-functions.ts";
import type { DocumentVersion } from "../../server/versions.ts";
import { browserEditorExtensions } from "./editor-extensions.ts";
import { restoreVersion } from "./version-restore.ts";

const when = new Intl.DateTimeFormat(formatLocale(), { dateStyle: "medium", timeStyle: "short" });

const label = (version: DocumentVersion) =>
  version.author === null
    ? m.documents_versions_earliest()
    : version.author.kind === "assistant"
      ? m.documents_versions_assistant()
      : version.author.name;

/**
 * The document's versions, newest first, and the chosen one shown as it was,
 * drawn by the editor itself so formulas, footnotes and pictures look as they
 * did. Restoring writes it back as a new edit; nothing is lost. A named
 * version is kept for good, so the list can be narrowed to those.
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
  const [namedOnly, setNamedOnly] = useState(false);
  const shown = namedOnly ? list.filter((each) => each.name !== null) : list;
  const queryClient = useQueryClient();
  const name = useMutation({
    mutationFn: (input: { revision: number; name: string }) =>
      nameDocumentVersion({ data: { documentId, ...input } }),
    // Shown at once; the refetch settles it.
    onMutate: (input) =>
      queryClient.setQueryData<DocumentVersion[] | null>(
        ["documents", "versions", documentId],
        (old) =>
          old?.map((each) =>
            each.revision === input.revision ? { ...each, name: input.name.trim() || null } : each,
          ),
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["documents", "versions", documentId] }),
    onError: (error) => toastError(m.documents_versions_name_failed(), error),
  });
  const [naming, setNaming] = useState<{ revision: number; draft: string } | null>(null);
  // Escape blurs the field too; this keeps that blur from saving.
  const cancelled = useRef(false);
  // The field replaces its row's pencil; focus goes back there once it closes.
  const pencils = useRef(new Map<number, HTMLButtonElement>());
  const returnTo = useRef<number | null>(null);
  useEffect(() => {
    if (naming || returnTo.current === null) return;
    pencils.current.get(returnTo.current)?.focus();
    returnTo.current = null;
  }, [naming]);
  const switchId = useId();
  const finish = (target: DocumentVersion) => {
    if (!naming) return;
    returnTo.current = target.revision;
    setNaming(null);
    if (cancelled.current) cancelled.current = false;
    else if (naming.draft.trim() !== (target.name ?? ""))
      name.mutate({ revision: target.revision, name: naming.draft });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{m.documents_editor_version_history()}</DialogTitle>
          <DialogDescription>{m.documents_versions_description()}</DialogDescription>
        </DialogHeader>
        <div className="flex h-[60vh] min-h-0 gap-4">
          <div className="min-w-0 flex-1 overflow-y-auto rounded-xl border px-4 py-3">
            {version.data ? (
              <VersionPreview key={selected} json={version.data} />
            ) : (
              <p className="text-muted-foreground text-sm">
                {version.isError ? m.documents_versions_gone() : m.documents_versions_loading()}
              </p>
            )}
          </div>
          <div className="flex w-60 shrink-0 flex-col gap-2">
            <Field orientation="horizontal" className="mx-3 justify-between">
              <FieldLabel htmlFor={switchId} className="text-muted-foreground">
                {m.documents_versions_named_only()}
              </FieldLabel>
              <Switch
                id={switchId}
                checked={namedOnly}
                onCheckedChange={(checked) => {
                  setNamedOnly(checked);
                  // Nothing hidden stays chosen, so Restore always means a listed version.
                  if (checked && !list.some((each) => each.revision === selected && each.name))
                    setChosen(list.find((each) => each.name !== null)?.revision ?? null);
                }}
              />
            </Field>
            {namedOnly && shown.length === 0 ? (
              <p className="text-muted-foreground px-3 text-sm">
                {m.documents_versions_none_named()}
              </p>
            ) : null}
            <ul aria-label={m.documents_versions_list()} className="min-h-0 flex-1 overflow-y-auto">
              {shown.map((each) => {
                const date =
                  each.revision === list[0]?.revision
                    ? m.documents_versions_current()
                    : when.format(new Date(each.at));
                return (
                  <li key={each.revision} className="group flex items-center gap-1">
                    {naming?.revision === each.revision ? (
                      <Input
                        // oxlint-disable-next-line jsx-a11y/no-autofocus -- opened by the name button for typing
                        autoFocus
                        aria-label={m.documents_versions_name_label()}
                        // Which version this is, while its row is the field.
                        placeholder={date}
                        value={naming.draft}
                        maxLength={100}
                        onChange={(event) =>
                          setNaming({ revision: each.revision, draft: event.target.value })
                        }
                        onBlur={() => finish(each)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") cancelled.current = true;
                          if (event.key === "Enter" || event.key === "Escape") {
                            event.preventDefault();
                            // The dialog would close on it too.
                            event.stopPropagation();
                            event.currentTarget.blur();
                          }
                        }}
                      />
                    ) : (
                      <>
                        <button
                          type="button"
                          aria-current={each.revision === selected ? "true" : undefined}
                          className={cn(
                            "hover:bg-muted flex min-w-0 flex-1 flex-col items-start rounded-lg px-3 py-2 text-left",
                            each.revision === selected && "bg-muted",
                          )}
                          onClick={() => setChosen(each.revision)}
                        >
                          <span className="w-full truncate text-sm font-medium">
                            {each.name ?? date}
                          </span>
                          <span className="text-muted-foreground w-full truncate text-xs">
                            {each.name ? `${date} · ${label(each)}` : label(each)}
                          </span>
                        </button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={
                            each.name ? m.documents_versions_rename() : m.documents_versions_name()
                          }
                          ref={(button) => {
                            if (button) pencils.current.set(each.revision, button);
                            else pencils.current.delete(each.revision);
                          }}
                          className={cn(
                            "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
                            each.revision === selected && "opacity-100",
                          )}
                          onClick={() =>
                            setNaming({ revision: each.revision, draft: each.name ?? "" })
                          }
                        >
                          <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
                        </Button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {m.common_close()}
          </Button>
          <Button
            disabled={!version.data || current}
            onClick={() => {
              if (!version.data) return;
              restoreVersion(editor, version.data);
              onOpenChange(false);
              toast.success(m.documents_versions_restored(), {
                description: m.documents_versions_restored_description(),
              });
            }}
          >
            {m.documents_versions_restore()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A version drawn read-only by the editor's own extensions. */
function VersionPreview({ json }: { json: JSONContent }) {
  const preview = useEditor({
    extensions: browserEditorExtensions(),
    // Named apart from the document itself, which stays open behind the dialog.
    editorProps: {
      attributes: { class: "rich-editor", "aria-label": m.documents_versions_preview() },
    },
    content: json,
    editable: false,
    immediatelyRender: true,
  });
  return <EditorContent editor={preview} />;
}
