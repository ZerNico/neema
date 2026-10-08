// Image tiles. A block names a search query; the server looked it up while
// the answer streamed and stored what it found with the message, so a tile
// only ever shows our own copy, never a URL the block chose.

import { use, useState } from "react";
import type { UiImage as Found, UiImageResult } from "~/modules/chat/assistant-output.ts";
import { AttachmentPreviewDialog } from "~/modules/attachments/ui/attachment-preview.tsx";
import { focusRingClassName } from "~/ui/focus-ring.ts";
import { Skeleton } from "~/ui/primitives/skeleton";
import { cn } from "~/ui/utils";
import type { ValidNode } from "../catalog.ts";
import { normalizeQuery } from "../extract.ts";
import { GenuiMessageContext } from "./context.ts";
import { UiLink } from "./link.tsx";

const aspectOf = (value: unknown, fallback: string) => {
  const match = typeof value === "string" ? /^(\d{1,2}):(\d{1,2})$/.exec(value) : null;
  return match && Number(match[1]) > 0 && Number(match[2]) > 0
    ? `${match[1]} / ${match[2]}`
    : fallback;
};

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
};

type Lookup = { found: Found } | { pending: true } | { missing: string };

/** What a query came to, as the tile should say it. */
function useLookup(): (query: string, index: number) => Lookup {
  const message = use(GenuiMessageContext);
  return (query, index) => {
    const result: UiImageResult | undefined = message?.images?.[normalizeQuery(query)];
    const found = result?.items[index];
    if (found) return { found };
    if (!result) return message?.streaming ? { pending: true } : { missing: "Image unavailable" };
    return {
      missing: result.status === "search_off" ? "Images need web search" : "Image unavailable",
    };
  };
}

function Tile({
  lookup,
  aspect,
  caption,
}: {
  lookup: Lookup;
  aspect: string;
  caption?: string | undefined;
}) {
  if ("pending" in lookup) return <Skeleton className="w-full" style={{ aspectRatio: aspect }} />;
  if ("missing" in lookup)
    return (
      <div
        className="bg-muted text-muted-foreground flex w-full items-center justify-center rounded-xl p-3 text-center text-xs"
        style={{ aspectRatio: aspect }}
      >
        {lookup.missing}
      </div>
    );
  return <FoundTile found={lookup.found} aspect={aspect} caption={caption} />;
}

function FoundTile({
  found,
  aspect,
  caption,
}: {
  found: Found;
  aspect: string;
  caption?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const url = `/api/files/${encodeURIComponent(found.attachmentId)}`;
  const name = caption ?? found.title;
  const host = hostOf(found.pageUrl);
  const image = (
    <img
      src={url}
      alt={name}
      loading="lazy"
      decoding="async"
      className="bg-muted w-full rounded-xl object-cover"
      style={{ aspectRatio: aspect }}
    />
  );
  return (
    <figure className="flex min-w-0 flex-col gap-1">
      {/* Images stored before their size was kept open nowhere: the preview would show a wrong size. */}
      {found.size === undefined ? (
        image
      ) : (
        <>
          <button
            type="button"
            aria-label={`Preview ${name}`}
            className={cn("cursor-zoom-in rounded-xl", focusRingClassName)}
            onClick={() => setOpen(true)}
          >
            {image}
          </button>
          <AttachmentPreviewDialog
            target={{ fileName: name, size: found.size, kind: "image", url }}
            open={open}
            onOpenChange={setOpen}
          />
        </>
      )}
      <figcaption className="text-muted-foreground flex min-w-0 flex-col text-xs">
        {caption ? <span>{caption}</span> : null}
        {host && /^https?:\/\//i.test(found.pageUrl) ? (
          <span className="truncate">
            <UiLink href={found.pageUrl}>{host}</UiLink>
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}

export function UiImage({ node }: { node: ValidNode }) {
  const lookup = useLookup();
  const query = typeof node.props.query === "string" ? node.props.query : "";
  const caption = typeof node.props.caption === "string" ? node.props.caption : undefined;
  return (
    <Tile
      lookup={lookup(query, 0)}
      aspect={aspectOf(node.props.aspect, "4 / 3")}
      caption={caption}
    />
  );
}

export function UiImages({ node }: { node: ValidNode }) {
  const lookup = useLookup();
  const queries = Array.isArray(node.props.query)
    ? node.props.query.filter((q): q is string => typeof q === "string")
    : [];
  const aspect = aspectOf(node.props.aspect, "1 / 1");
  // One query fills the row with its images; several show the best of each.
  const tiles =
    queries.length === 1
      ? [0, 1, 2, 3]
          .map((index) => ({ key: `${queries[0]}-${index}`, at: lookup(queries[0]!, index) }))
          .filter((tile, index) => index === 0 || "found" in tile.at)
      : queries.map((query) => ({ key: query, at: lookup(query, 0) }));
  const carousel = node.props.layout === "carousel";
  return (
    <div
      className={cn(
        carousel
          ? "flex snap-x snap-mandatory gap-2 overflow-x-auto pb-1 *:w-48 *:shrink-0 *:snap-start"
          : "grid grid-cols-2 gap-2 sm:grid-cols-3",
      )}
    >
      {tiles.map((tile) => (
        <Tile key={tile.key} lookup={tile.at} aspect={aspect} />
      ))}
    </div>
  );
}
