import {
  FileAddIcon,
  File01Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { formatLocale } from "~/i18n/formats.ts";
import { relativeAgeLabel } from "~/modules/chat/ui/timestamps.ts";
import { m } from "~/paraglide/messages.js";
import {
  EmptyState,
  ErrorState,
  ListCard,
  ListRow,
  ListSkeleton,
  Page,
  Section,
} from "~/ui/page-shell.tsx";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { documentLibraryQuery } from "../client/document-queries.ts";
import type { LibraryDocument } from "../schema.ts";
import { DocumentLifecycleItems } from "./document-lifecycle.tsx";
import { DocumentOwner } from "./document-owner.tsx";
import { useDocumentPanel } from "./document-panel-context.ts";
import { RenameDocumentDialog } from "./rename-document-dialog.tsx";
import { DocumentShareDialog } from "./document-share-dialog.tsx";
import { NewDocumentDialog } from "./new-document-dialog.tsx";

/** A person's own documents from every chat, and those shared with them, opened in the panel beside the list. */
export function DocumentLibraryPage() {
  const library = useQuery(documentLibraryQuery);
  const rows = library.data ?? [];
  const own = rows.filter((document) => document.sharedBy === null);
  const shared = rows.filter((document) => document.sharedBy !== null);
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState<string | null>(null);
  const row = (document: LibraryDocument) => (
    <LibraryRow
      key={document.id}
      document={document}
      openNow={document.id === justCreated}
      onOpened={() => setJustCreated(null)}
    />
  );
  return (
    <Page
      title={m.documents_library_title()}
      rootPath="/"
      rootLabel={m.projects_list_root_label()}
      actions={
        <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
          <HugeiconsIcon icon={FileAddIcon} strokeWidth={2} data-icon="inline-start" />
          {m.projects_documents_new()}
        </Button>
      }
    >
      {library.isError ? (
        <ErrorState
          title={m.documents_library_load_failed()}
          onRetry={() => {
            void library.refetch();
          }}
        />
      ) : library.data === undefined ? (
        <ListSkeleton label={m.documents_library_loading()} />
      ) : rows.length === 0 ? (
        <EmptyState icon={File01Icon} title={m.documents_library_empty()} />
      ) : (
        // Keeps each open document's controller mounted while the page is, as a project's list does.
        <DocumentOwner documentIds={rows.map((row) => row.id)} onGone={() => undefined}>
          {own.length > 0 ? (
            <Section title={m.documents_library_yours()}>
              <ListCard>{own.map(row)}</ListCard>
            </Section>
          ) : null}
          {shared.length > 0 ? (
            <Section title={m.documents_library_shared()}>
              <ListCard>{shared.map(row)}</ListCard>
            </Section>
          ) : null}
        </DocumentOwner>
      )}
      <NewDocumentDialog
        projectId={null}
        open={creating}
        onOpenChange={setCreating}
        onCreated={setJustCreated}
      />
    </Page>
  );
}

function LibraryRow({
  document,
  openNow,
  onOpened,
}: {
  document: LibraryDocument;
  /** Just created here, so it opens once its panel entry exists. */
  openNow: boolean;
  onOpened: () => void;
}) {
  const { entry } = useDocumentPanel(document.id);
  const open = entry?.open;
  useEffect(() => {
    if (!openNow || !open) return;
    open();
    onOpened();
  }, [openNow, open, onOpened]);
  const [renaming, setRenaming] = useState(false);
  const [sharing, setSharing] = useState(false);
  const title = entry?.title ?? document.title;
  const age = relativeAgeLabel(document.updatedAt, undefined, formatLocale());
  return (
    <ListRow>
      <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-2xl">
        <HugeiconsIcon icon={File01Icon} strokeWidth={2} className="size-4" />
      </div>
      <button
        type="button"
        className="flex min-w-0 flex-1 flex-col text-left"
        aria-label={m.projects_documents_open({ title })}
        aria-expanded={entry?.expanded ?? false}
        disabled={!entry?.open}
        onClick={() => entry?.open?.()}
      >
        <span className="truncate text-sm font-medium">{title}</span>
        <span className="text-muted-foreground truncate text-xs">
          {document.sharedBy
            ? m.documents_library_shared_by({ name: document.sharedBy, age })
            : document.conversationTitle
              ? m.documents_library_from_chat({ chat: document.conversationTitle, age })
              : m.documents_library_updated({ age })}
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={m.documents_library_actions({ title })}
            />
          }
        >
          <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {document.canEdit ? (
            <>
              <DropdownMenuItem onClick={() => setRenaming(true)}>
                <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
                {m.common_rename()}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DocumentLifecycleItems document={document} onShare={() => setSharing(true)} />
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameDocumentDialog document={document} open={renaming} onOpenChange={setRenaming} />
      <DocumentShareDialog
        document={document}
        manage={document.sharedBy === null}
        open={sharing}
        onOpenChange={setSharing}
      />
    </ListRow>
  );
}
