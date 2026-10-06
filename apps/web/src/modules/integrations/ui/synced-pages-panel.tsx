import { ArrowLeft01Icon, LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { knowledgeCollectionQuery } from "~/modules/knowledge/client/queries.ts";
import { searchState, type KnowledgeDocument } from "~/modules/knowledge/schema.ts";
import { DocumentSourcePanel } from "~/modules/knowledge/ui/document-source-panel.tsx";
import { useDetailPanel } from "~/ui/detail-panel-context.ts";
import { Button } from "~/ui/primitives/button";
import { Input } from "~/ui/primitives/input";
import { Spinner } from "~/ui/primitives/spinner";
import { IntegrationLogo } from "./integration-logo.tsx";
import { useIntegrationDirectory } from "../client/directory.ts";

const isPreparing = (document: KnowledgeDocument) =>
  document.status === "queued" ||
  document.status === "extracting" ||
  document.replacement?.status === "queued" ||
  document.replacement?.status === "extracting";

/**
 * Reads the collection live rather than taking a snapshot, so a sync that
 * lands while the panel is open shows up in it.
 */
export function SyncedPagesPanel({
  collectionId,
  sourceId,
  title,
  onBack,
}: {
  collectionId: string;
  sourceId: string;
  title: string;
  /** Reopens this list from a page read inside it. */
  onBack: () => void;
}) {
  const panel = useDetailPanel();
  const detail = useQuery(knowledgeCollectionQuery(collectionId));
  const [filter, setFilter] = useState("");
  const directory = useIntegrationDirectory();
  if (detail.isPending)
    return (
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Spinner /> Loading…
      </div>
    );
  const pages = (detail.data?.documents ?? []).filter(
    (document) => document.source?.sourceId === sourceId,
  );
  const integrationId = pages[0]?.source?.integrationId ?? "";
  const query = filter.trim().toLowerCase();
  const shown = query
    ? pages.filter((document) => document.title.toLowerCase().includes(query))
    : pages;
  const name = directory.name(integrationId);

  const read = (document: KnowledgeDocument) =>
    panel.open({
      id: `knowledge-note:${document.versionId}`,
      title: document.title,
      actions: (
        <Button size="sm" variant="ghost" onClick={onBack}>
          <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} data-icon="inline-start" />
          {title}
        </Button>
      ),
      body: (
        <DocumentSourcePanel
          source={{
            kind: "document",
            index: 0,
            title: document.title,
            snippet: "",
            read: true,
            collectionId,
            documentId: document.id,
            versionId: document.versionId!,
            startOffset: 0,
            endOffset: document.charCount!,
            page: null,
            headingPath: "",
          }}
        />
      ),
    });

  return (
    <div className="flex flex-col gap-3">
      <Input
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder={`Filter ${pages.length} ${pages.length === 1 ? "page" : "pages"}…`}
        aria-label="Filter synced pages"
      />
      {shown.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {pages.length ? "No page matches." : "Nothing synced yet."}
        </p>
      ) : (
        <ul className="flex flex-col">
          {shown.map((document) => {
            const readable =
              document.status === "ready" && !!document.versionId && !!document.charCount;
            return (
              <li
                key={document.id}
                className="hover:bg-muted/60 flex items-center gap-2 rounded-xl px-2 py-1.5"
              >
                <IntegrationLogo integrationId={integrationId} className="text-muted-foreground" />
                {readable ? (
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-sm"
                    onClick={() => read(document)}
                  >
                    {document.title}
                  </button>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-sm">{document.title}</span>
                )}
                {document.status === "failed" ? (
                  <span className="text-destructive shrink-0 text-xs">Couldn’t prepare</span>
                ) : isPreparing(document) ? (
                  <span className="text-muted-foreground shrink-0 text-xs">Preparing</span>
                ) : searchState(document) === "basic" ? (
                  <span className="text-muted-foreground shrink-0 text-xs">Basic search</span>
                ) : searchState(document) === "preparing" ? (
                  <span className="text-muted-foreground shrink-0 text-xs">Preparing search</span>
                ) : null}
                {document.source?.url ? (
                  <a
                    href={document.source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-muted-foreground hover:text-foreground shrink-0"
                    aria-label={`Open ${document.title} in ${name}`}
                  >
                    <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={2} className="size-3.5" />
                  </a>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
