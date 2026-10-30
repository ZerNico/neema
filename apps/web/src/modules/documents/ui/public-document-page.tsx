import { FileNotFoundIcon } from "@hugeicons/core-free-icons";
import { EditorContent, useEditor, type JSONContent } from "@tiptap/react";
import { formatLocale } from "~/i18n/formats.ts";
import { relativeAgeLabel } from "~/modules/chat/ui/timestamps.ts";
import { m } from "~/paraglide/messages.js";
import { EmptyState } from "~/ui/page-shell.tsx";
import { RouteStatusScreen } from "~/ui/route-error.tsx";
import type { PublicDocument } from "../schema.ts";
import { browserEditorExtensions } from "./rich-editor/editor-extensions.ts";

/** A document through its public link: read-only, nothing of the app around it. */
export function PublicDocumentPage({ document }: { document: PublicDocument | null }) {
  if (!document)
    return (
      <RouteStatusScreen>
        <EmptyState
          icon={FileNotFoundIcon}
          title={m.documents_public_unavailable()}
          description={m.documents_public_unavailable_description()}
          className="w-full max-w-lg"
        />
      </RouteStatusScreen>
    );
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-1 border-b pb-6">
        <h1 className="text-2xl font-semibold">{document.title}</h1>
        <p className="text-muted-foreground text-sm">
          {m.documents_library_shared_by({
            name: document.ownerName,
            age: relativeAgeLabel(document.updatedAt, undefined, formatLocale()),
          })}
        </p>
      </header>
      <PublicContent content={document.content} title={document.title} />
    </main>
  );
}

function PublicContent({ content, title }: { content: string; title: string }) {
  const editor = useEditor({
    extensions: browserEditorExtensions(),
    editorProps: { attributes: { class: "rich-editor", "aria-label": title } },
    content: JSON.parse(content) as JSONContent,
    editable: false,
    immediatelyRender: true,
  });
  return <EditorContent editor={editor} />;
}
