import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { deleteAttachment } from "~/modules/attachments/server/functions.ts";
import { myLibraryQuery, myStorageQuery } from "~/modules/limits/client/queries.ts";
import { formatBytes, LIBRARY_LISTED } from "~/modules/limits/rules.ts";
import type { LibraryFile, LibraryPlace } from "~/modules/limits/server/library.ts";
import { removeChatFile } from "~/modules/limits/server/functions.ts";
import { useConfirm } from "~/ui/confirm-context.ts";
import { toastError } from "~/ui/error-toast.ts";
import { EmptyState, ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { buttonVariants } from "~/ui/primitives/button";
import { Progress } from "~/ui/primitives/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { SearchInput } from "~/ui/search-input.tsx";
import {
  Csv01Icon,
  Doc01Icon,
  File01Icon,
  HardDriveIcon,
  Image01Icon,
  Pdf01Icon,
  Ppt01Icon,
  Txt01Icon,
  Xls01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { attachmentUrl } from "~/modules/attachments/client/use-attachment-uploads.ts";
import { documentImagePath } from "~/modules/documents/schema.ts";
import { cardSurfaceClassName } from "~/ui/card-surface.ts";
import { cn } from "~/ui/utils";

type Filter = "all" | LibraryPlace["kind"];

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: "all", label: "All files" },
  { value: "chat", label: "Chats" },
  { value: "upload", label: "Not sent" },
  { value: "document", label: "Documents" },
  { value: "project", label: "Projects" },
  { value: "knowledge", label: "Knowledge" },
  { value: "skill", label: "Skills" },
];

const SORTS = [
  { value: "size", label: "Largest first" },
  { value: "date", label: "Newest first" },
] as const;

/** Where one place is, in a few words. */
const placeText = (place: LibraryPlace) => {
  switch (place.kind) {
    case "chat":
      return place.deleted ? "In a deleted chat" : `In “${place.title ?? "Untitled chat"}”`;
    case "upload":
      return "Not sent yet";
    case "document":
      return `In the document “${place.title}”`;
    case "project":
      return `Project “${place.projectName}”${place.versions > 1 ? ` · ${place.versions} versions` : ""}`;
    case "knowledge":
      return `Collection “${place.collectionName}”`;
    case "skill":
      return `Skill “${place.skillName}”`;
  }
};

/** A file can be deleted here when every place it is in is a chat message or an unsent upload. */
const removable = (file: LibraryFile) =>
  file.places.length > 0 &&
  file.places.every(
    (place) => place.kind === "upload" || (place.kind === "chat" && place.removable),
  );

/** What a person stores, against their quota, with each file and where it is used. */
export function StoragePage() {
  const { data: standing } = useSuspenseQuery(myStorageQuery);
  const { data: library } = useQuery(myLibraryQuery);
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<(typeof SORTS)[number]["value"]>("size");
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["my-storage"] });

  const remove = useMutation({
    mutationFn: async (file: LibraryFile) => {
      for (const place of file.places) {
        if (place.kind === "upload")
          await deleteAttachment({ data: { attachmentId: place.attachmentId } });
        else if (place.kind === "chat")
          await removeChatFile({ data: { attachmentId: place.attachmentId } });
      }
    },
    onSettled: refresh,
    onError: (error) => toastError("Could not delete the file.", error),
  });

  const label =
    standing.quota === null
      ? `${formatBytes(standing.used)} used`
      : `${formatBytes(standing.used)} of ${formatBytes(standing.quota)} used`;
  const needle = query.trim().toLowerCase();
  const files = (library?.files ?? [])
    .filter((file) => filter === "all" || file.places.some((place) => place.kind === filter))
    .filter(
      (file) => !needle || file.places.some((place) => place.name.toLowerCase().includes(needle)),
    )
    .toSorted((a, b) =>
      sort === "size" ? b.size - a.size : b.createdAt.localeCompare(a.createdAt),
    );

  return (
    <Page title="Storage" rootPath="/settings" rootLabel="Settings">
      <Section title="Used" description="A file used in several places counts once.">
        <ListCard>
          <ListRow className="flex-col items-stretch gap-2">
            <span className="text-sm font-medium">{label}</span>
            {standing.quota === null ? null : (
              <Progress
                value={Math.min(100, (standing.used / standing.quota) * 100)}
                aria-label={label}
              />
            )}
          </ListRow>
        </ListCard>
      </Section>
      <Section title="Files">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            aria-label="Search files"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-48 flex-1"
          />
          <Select
            value={filter}
            items={FILTERS}
            onValueChange={(value) => setFilter(value as Filter)}
          >
            <SelectTrigger aria-label="Where" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FILTERS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={sort}
            items={SORTS}
            onValueChange={(value) => setSort(value as (typeof SORTS)[number]["value"])}
          >
            <SelectTrigger aria-label="Order" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORTS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {library && library.files.length >= LIBRARY_LISTED ? (
          <p className="text-muted-foreground text-sm">
            Showing your {LIBRARY_LISTED} largest files.
          </p>
        ) : null}
        {!library ? null : files.length === 0 ? (
          <EmptyState
            icon={HardDriveIcon}
            title={library.files.length === 0 ? "No files yet" : "Nothing matches"}
            description={
              library.files.length === 0
                ? "Files you add to chats, projects and collections show up here."
                : "Try another search or place."
            }
          />
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {files.map((file) => (
              <FileTile
                key={file.blobId}
                file={file}
                pending={remove.isPending && remove.variables?.blobId === file.blobId}
                onDelete={async () => {
                  const chats = file.places.filter((place) => place.kind === "chat").length;
                  if (
                    await confirm({
                      title: `Delete “${file.places[0]?.name ?? "this file"}”?`,
                      description:
                        chats > 0
                          ? "It is taken out of the messages it was sent with, and chats no longer read it."
                          : "It was never sent, so nothing else changes.",
                      confirmLabel: "Delete",
                    })
                  )
                    remove.mutate(file);
                }}
              />
            ))}
          </ul>
        )}
      </Section>
    </Page>
  );
}

/** What a file is, for a tile without a picture of it. */
const typeIcon = (mediaType: string) =>
  mediaType.startsWith("image/")
    ? Image01Icon
    : mediaType === "application/pdf"
      ? Pdf01Icon
      : mediaType.includes("presentation")
        ? Ppt01Icon
        : mediaType.includes("spreadsheet") || mediaType === "application/vnd.ms-excel"
          ? Xls01Icon
          : mediaType.includes("wordprocessing") || mediaType === "application/msword"
            ? Doc01Icon
            : mediaType === "text/csv"
              ? Csv01Icon
              : mediaType.startsWith("text/")
                ? Txt01Icon
                : File01Icon;

/**
 * An image the person stores, drawn from the attachment it is: its bytes as they are, loaded
 * only when the tile scrolls into view. A document's image is served only through its
 * document. Project files are downloads only, so they show icons.
 */
const imageOf = (file: LibraryFile) => {
  if (!file.mediaType.startsWith("image/")) return null;
  for (const place of file.places)
    if (place.kind === "chat" || place.kind === "upload") return attachmentUrl(place.attachmentId);
  const document = file.places.find((place) => place.kind === "document");
  return document ? documentImagePath(document.documentId, document.attachmentId) : null;
};

function FileTile({
  file,
  pending,
  onDelete,
}: {
  file: LibraryFile;
  pending: boolean;
  onDelete: () => void;
}) {
  const first = file.places[0];
  const more = file.places.length - 1;
  // Where to go about it: the place that keeps it from being deleted here. A deleted chat
  // has nowhere to open, and is gone with its files once its Undo runs out.
  const managed =
    file.places.find(
      (place) =>
        place.kind === "project" ||
        place.kind === "knowledge" ||
        place.kind === "skill" ||
        (place.kind === "document" && (place.projectId || place.conversationId)),
    ) ?? file.places.find((place) => place.kind === "chat" && !place.deleted);
  const where = first
    ? `${placeText(first)}${more > 0 ? ` and ${more === 1 ? "1 more place" : `${more} more places`}` : ""}`
    : "Not in use";
  const image = imageOf(file);
  const [broken, setBroken] = useState(false);
  return (
    <li className={cn(cardSurfaceClassName, "flex min-w-0 flex-col overflow-hidden")}>
      <div className="bg-muted text-muted-foreground flex aspect-[4/3] items-center justify-center">
        {image && !broken ? (
          <img
            src={image}
            alt=""
            loading="lazy"
            decoding="async"
            className="size-full object-cover"
            onError={() => setBroken(true)}
          />
        ) : (
          <HugeiconsIcon icon={typeIcon(file.mediaType)} strokeWidth={2} className="size-8" />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 px-3 pt-2.5">
        <span className="truncate text-sm font-medium" title={first?.name}>
          {first?.name ?? "Untitled file"}
        </span>
        <span className="text-muted-foreground line-clamp-2 text-xs">
          {formatBytes(file.size)} · {where}
        </span>
      </div>
      <div className="flex justify-end px-1.5 pb-1.5">
        {removable(file) ? (
          <PendingButton size="sm" variant="ghost" pending={pending} onClick={onDelete}>
            Delete
          </PendingButton>
        ) : managed ? (
          <PlaceLink place={managed} className={buttonVariants({ variant: "ghost", size: "sm" })}>
            Open
          </PlaceLink>
        ) : null}
      </div>
    </li>
  );
}

/** Where a file is managed, for the places this page does not delete from. */
function PlaceLink({
  place,
  className,
  children,
}: {
  place: LibraryPlace;
  className: string;
  children: ReactNode;
}) {
  const props = { className, children };
  switch (place.kind) {
    case "project":
      return <Link to="/projects/$projectId" params={{ projectId: place.projectId }} {...props} />;
    case "knowledge":
      return (
        <Link
          to="/knowledge/$collectionId"
          params={{ collectionId: place.collectionId }}
          {...props}
        />
      );
    case "skill":
      return <Link to="/skills/$skillId" params={{ skillId: place.skillId }} {...props} />;
    case "document":
      return place.projectId ? (
        <Link to="/projects/$projectId" params={{ projectId: place.projectId }} {...props} />
      ) : (
        <Link
          to="/chat/$conversationId"
          params={{ conversationId: place.conversationId ?? "" }}
          {...props}
        />
      );
    case "chat":
      return (
        <Link
          to="/chat/$conversationId"
          params={{ conversationId: place.conversationId }}
          {...props}
        />
      );
    case "upload":
      return null;
  }
}
