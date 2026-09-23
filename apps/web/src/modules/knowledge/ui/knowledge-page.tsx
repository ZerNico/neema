import { FolderLibraryIcon, ArrowRight01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { useState } from "react";
import { toast } from "sonner";
import { knowledgeCollectionsQuery } from "../client/queries.ts";
import { CollectionIdentityInput, KNOWLEDGE_LIMITS, type CollectionSummary } from "../schema.ts";
import { createKnowledgeCollection, updateKnowledgeCollection } from "../server/functions.ts";
import { useAppForm } from "~/ui/form/app-form.tsx";
import {
  EmptyState,
  ErrorState,
  ListCard,
  ListRow,
  ListSkeleton,
  Page,
  Section,
} from "~/ui/page-shell.tsx";
import { Badge } from "~/ui/primitives/badge";
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

export const collectionStatusLabel = (collection: CollectionSummary): string => {
  const parts: string[] = [`${collection.documentCount} documents`];
  if (collection.pendingCount > 0) parts.push(`${collection.pendingCount} preparing`);
  if (collection.failedCount > 0) parts.push(`${collection.failedCount} failed`);
  return parts.join(" · ");
};

/**
 * Create or rename a collection. Names and descriptions are the only editable
 * identity; documents live on the detail page.
 */
export function CollectionDialog({
  open,
  onOpenChange,
  collection,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Absent creates a new collection. */
  collection?: Pick<CollectionSummary, "id" | "name" | "description"> | undefined;
  onCreated?: ((collectionId: string) => void) | undefined;
}) {
  const queryClient = useQueryClient();
  const form = useAppForm({
    defaultValues: {
      name: collection?.name ?? "",
      description: collection?.description ?? "",
    },
    validators: { onSubmit: Schema.toStandardSchemaV1(CollectionIdentityInput) },
    onSubmit: async ({ value }) => {
      try {
        if (collection) {
          await updateKnowledgeCollection({ data: { collectionId: collection.id, ...value } });
        } else {
          const id = await createKnowledgeCollection({ data: value });
          onCreated?.(id);
        }
        await queryClient.invalidateQueries({ queryKey: ["knowledge"] });
        onOpenChange(false);
        form.reset();
      } catch (error) {
        toast.error(
          error instanceof Error && error.message
            ? error.message
            : "Could not save the collection.",
        );
      }
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && form.state.isSubmitting) return;
        onOpenChange(next);
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{collection ? "Rename collection" : "New collection"}</DialogTitle>
          <DialogDescription>Private until you share it.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (!form.state.isSubmitting) void form.handleSubmit();
          }}
        >
          <form.AppField name="name">
            {(field) => <field.TextField label="Name" placeholder="Contracts" />}
          </form.AppField>
          <form.AppField name="description">
            {(field) => <field.TextareaField label="Description" optional rows={2} />}
          </form.AppField>
          <form.AppForm>
            <DialogFooter>
              <form.Subscribe selector={(state) => state.isSubmitting}>
                {(isSubmitting) => (
                  <DialogClose render={<Button variant="outline" disabled={isSubmitting} />}>
                    Cancel
                  </DialogClose>
                )}
              </form.Subscribe>
              <form.SubmitButton>{collection ? "Save" : "Create collection"}</form.SubmitButton>
            </DialogFooter>
          </form.AppForm>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function KnowledgePage() {
  const navigate = useNavigate();
  const collections = useQuery(knowledgeCollectionsQuery);
  const [creating, setCreating] = useState(false);
  const rows = collections.data ?? [];
  const own = rows.filter((collection) => collection.canEdit);
  const shared = rows.filter((collection) => !collection.canEdit);
  const atLimit = own.length >= KNOWLEDGE_LIMITS.maxCollectionsPerUser;
  // Recipients still open a collection to read its documents; only the owner
  // gets Edit, which is the same page with its mutation controls.
  const collectionRows = (items: CollectionSummary[]) => (
    <ListCard>
      {items.map((collection) => (
        <Link
          key={collection.id}
          to="/knowledge/$collectionId"
          params={{ collectionId: collection.id }}
          aria-label={`Open ${collection.name}`}
          className="block"
        >
          <ListRow interactive>
            <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-2xl">
              <HugeiconsIcon icon={FolderLibraryIcon} strokeWidth={2} className="size-4" />
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-2 text-sm font-medium">
                <span className="truncate">{collection.name}</span>
                {collection.audience === "instance" ? (
                  <Badge variant="outline">Everyone</Badge>
                ) : null}
                {collection.failedCount > 0 ? (
                  <Badge variant="destructive">{collection.failedCount} failed</Badge>
                ) : collection.pendingCount > 0 ? (
                  <Badge variant="secondary">{collection.pendingCount} preparing</Badge>
                ) : null}
              </span>
              <span className="text-muted-foreground truncate text-xs">
                {[
                  collection.description || collectionStatusLabel(collection),
                  collection.ownerName ? `Shared by ${collection.ownerName}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              strokeWidth={2}
              className="text-muted-foreground size-4 shrink-0"
            />
          </ListRow>
        </Link>
      ))}
    </ListCard>
  );
  return (
    <Page
      title="Knowledge"
      rootPath="/"
      rootLabel="Chat"
      actions={
        <Button size="sm" onClick={() => setCreating(true)} disabled={atLimit}>
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
          New collection
        </Button>
      }
    >
      {collections.isError ? (
        <ErrorState
          title="Could not load collections"
          onRetry={() => {
            void collections.refetch();
          }}
        />
      ) : collections.data === undefined ? (
        <ListSkeleton label="Loading collections" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={FolderLibraryIcon}
          title="No collections yet"
          description="Keep documents together to use in chats and agents."
          action={
            <Button size="sm" onClick={() => setCreating(true)}>
              <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
              New collection
            </Button>
          }
        />
      ) : (
        <>
          {own.length > 0 ? (
            <Section title="Your collections">{collectionRows(own)}</Section>
          ) : null}
          {shared.length > 0 ? (
            <Section title="Shared with you">{collectionRows(shared)}</Section>
          ) : null}
        </>
      )}
      <CollectionDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(collectionId) => {
          void navigate({ to: "/knowledge/$collectionId", params: { collectionId } });
        }}
      />
    </Page>
  );
}
