import { Cancel01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ComponentProps, ReactNode } from "react";
import { knowledgeCollectionsQuery } from "~/modules/knowledge/client/queries.ts";
import { KNOWLEDGE_LIMITS, type CollectionSummary } from "~/modules/knowledge/schema.ts";
import { ErrorState, ListCard, ListRow, ListSkeleton } from "~/ui/page-shell.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "~/ui/primitives/combobox";
import { FieldError } from "~/ui/primitives/field";

/** The knowledge collections a saved configuration attaches, with any the reader lost. */
export function CollectionsField({
  value,
  onChange,
  errors,
  showOwner = false,
  children,
}: {
  value: readonly string[];
  onChange: (ids: string[]) => void;
  errors: NonNullable<ComponentProps<typeof FieldError>["errors"]>;
  /** Name who shared a collection, for configurations other people use. */
  showOwner?: boolean;
  /** Rendered below the picker, above the limit note. */
  children?: ReactNode;
}) {
  const collections = useQuery(knowledgeCollectionsQuery);
  if (collections.isError)
    return (
      <ErrorState title="Could not load collections" onRetry={() => void collections.refetch()} />
    );
  if (collections.data === undefined)
    return <ListSkeleton rows={2} media="none" label="Loading collections" />;
  const known = collections.data;
  const attached = value.flatMap((id) => {
    const collection = known.find((candidate) => candidate.id === id);
    return collection ? [collection] : [];
  });
  const unavailable = value.filter((id) => !known.some((candidate) => candidate.id === id));
  const addable = known.filter((collection) => !value.includes(collection.id));
  const atLimit = value.length >= KNOWLEDGE_LIMITS.maxCollectionsPerSelection;
  const detach = (id: string) => onChange(value.filter((current) => current !== id));
  const detail = (collection: CollectionSummary) =>
    `${collection.documentCount} documents${
      showOwner && collection.ownerName ? ` · shared by ${collection.ownerName}` : ""
    }`;
  return (
    <div
      role="group"
      aria-label="Knowledge collections"
      tabIndex={-1}
      aria-invalid={errors.length > 0 || undefined}
      className="flex flex-col gap-3"
    >
      {attached.length > 0 || unavailable.length > 0 ? (
        <ListCard>
          {attached.map((collection) => (
            <ListRow key={collection.id}>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{collection.name}</span>
                <span className="text-muted-foreground truncate text-xs">{detail(collection)}</span>
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${collection.name}`}
                onClick={() => detach(collection.id)}
              >
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
              </Button>
            </ListRow>
          ))}
          {unavailable.map((id) => (
            <ListRow key={id}>
              <span className="flex-1 text-sm">A collection you can no longer read</span>
              <Badge variant="destructive">Unavailable</Badge>
              <Button
                size="icon-sm"
                variant="ghost"
                className="text-muted-foreground hover:text-foreground"
                aria-label="Remove unavailable collection"
                onClick={() => detach(id)}
              >
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
              </Button>
            </ListRow>
          ))}
        </ListCard>
      ) : null}
      {known.length === 0 && unavailable.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No collections yet.{" "}
          <Link to="/knowledge" className="underline underline-offset-2">
            Manage knowledge
          </Link>
        </p>
      ) : (
        // A searchable picker rather than a switch per row: the list grows
        // with the account, the attached ones do not.
        <Combobox
          items={addable}
          value={null}
          disabled={atLimit || addable.length === 0}
          onValueChange={(collection: CollectionSummary | null) => {
            if (collection && !atLimit) onChange([...value, collection.id]);
          }}
          itemToStringLabel={(collection: CollectionSummary) => collection.name}
          isItemEqualToValue={(a: CollectionSummary, b: CollectionSummary) => a.id === b.id}
          autoHighlight
        >
          <ComboboxTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                disabled={atLimit || addable.length === 0}
                aria-label="Add collection"
              />
            }
          >
            <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
            Add collection
          </ComboboxTrigger>
          <ComboboxContent align="start" className="w-72">
            <ComboboxInput placeholder="Search collections…" showTrigger={false} />
            <ComboboxEmpty>No collections match</ComboboxEmpty>
            <ComboboxList>
              {(collection: CollectionSummary) => (
                <ComboboxItem key={collection.id} value={collection}>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{collection.name}</span>
                    <span className="text-muted-foreground truncate text-xs">
                      {detail(collection)}
                    </span>
                  </span>
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      )}
      {children}
      {atLimit ? (
        <p className="text-muted-foreground text-xs">
          Up to {KNOWLEDGE_LIMITS.maxCollectionsPerSelection} collections.
        </p>
      ) : null}
      <FieldError errors={errors} />
    </div>
  );
}
