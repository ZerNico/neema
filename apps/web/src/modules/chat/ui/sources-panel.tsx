import { File01Icon, Link01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { DocumentSource } from "~/modules/tools/source-schema.ts";
import { documentLocationLabel } from "~/modules/tools/sources.ts";
import { useDocumentSourcePanel } from "~/modules/knowledge/ui/document-source-panel.tsx";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ToolSource } from "../client/use-message-stream.ts";
import { IntegrationLogo, integrationName } from "~/modules/integrations/ui/integration-logo.tsx";
import { Favicon, hostOf } from "./favicon.tsx";
import { collectSources, selectAnswerSources } from "./citations.ts";
import { NO_INHERITED_SOURCES } from "./inherited-sources.ts";
import type { DisplayMessage } from "./message-list.tsx";
import { useDetailPanel, useDetailPanelTabIds, type DetailPanelRequest } from "~/ui/detail-panel";

function SourceRow({ source }: { source: ToolSource }) {
  if (source.kind === "document") return <DocumentSourceRow source={source} />;
  return (
    <li className="rounded-lg p-3">
      <a
        href={source.url}
        target="_blank"
        rel="noreferrer noopener"
        className="group flex flex-col gap-1.5"
      >
        <div className="flex items-center gap-2">
          {source.kind === "integration" ? (
            <IntegrationLogo integrationId={source.integrationId} />
          ) : (
            <Favicon url={source.url} className="size-4" />
          )}
          <span className="text-muted-foreground min-w-0 truncate text-xs">
            {source.kind === "integration"
              ? integrationName(source.integrationId)
              : hostOf(source.url)}
          </span>
        </div>
        <p className="group-hover:text-primary text-sm leading-snug font-medium transition-colors">
          {source.title || hostOf(source.url)}
        </p>
        {source.snippet ? (
          <p className="text-muted-foreground line-clamp-3 text-xs leading-relaxed">
            {source.snippet}
          </p>
        ) : null}
      </a>
    </li>
  );
}

function DocumentSourceRow({ source }: { source: DocumentSource }) {
  const open = useDocumentSourcePanel(source);
  return (
    <li className="rounded-lg p-3">
      <button
        type="button"
        onClick={open}
        className="group flex w-full flex-col gap-1.5 text-left"
        aria-label={`Source: ${source.title || "Document"}`}
      >
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <HugeiconsIcon icon={File01Icon} strokeWidth={2} className="size-4" aria-hidden />
          <span className="min-w-0 truncate">{documentLocationLabel(source)}</span>
        </div>
        <p className="group-hover:text-primary text-sm leading-snug font-medium transition-colors">
          {source.title || "Document"}
        </p>
        {source.snippet ? (
          <p className="text-muted-foreground line-clamp-3 text-xs leading-relaxed">
            {source.snippet}
          </p>
        ) : null}
      </button>
    </li>
  );
}

const SOURCES_PREFIX = "sources:";

const sourcesRequest = (messageId: string, sources: ToolSource[]): DetailPanelRequest => ({
  id: `${SOURCES_PREFIX}${messageId}`,
  title: "Sources",
  subtitle: `${sources.length}`,
  icon: Link01Icon,
  restorable: true,
  body: <SourcesPanelBody sources={sources} />,
});

/**
 * Opens this message's sources in the detail panel.
 *
 * `sources` is snapshotted into the panel body on each open; `SourcesPanelOwner`
 * keeps an open tab current from then on.
 */
export function useSourcesPanel(messageId: string, sources: ToolSource[]) {
  const panel = useDetailPanel();
  return useCallback(
    () => panel.open(sourcesRequest(messageId, sources)),
    [panel, messageId, sources],
  );
}

/**
 * Mounted by ChatView beside `ResearchPanelOwner`: a sources tab outlives the
 * transcript row that opened it, and a restored one has only its message id.
 */
export function SourcesPanelOwner({ messages }: { messages: ReadonlyArray<DisplayMessage> }) {
  const tabIds = useDetailPanelTabIds();
  return tabIds
    .filter((id) => id.startsWith(SOURCES_PREFIX))
    .map((id) => (
      <SourcesTabOwner
        key={id}
        id={id}
        message={messages.find((message) => `${SOURCES_PREFIX}${message.id}` === id)}
      />
    ));
}

function SourcesTabOwner({ id, message }: { id: string; message: DisplayMessage | undefined }) {
  const panel = useDetailPanel();
  const sources = message
    ? selectAnswerSources(
        message.content,
        collectSources(message.toolActivities),
        message.inheritedSources ?? NO_INHERITED_SOURCES,
      )
    : null;
  // The list is recomputed on every streamed token; the panel only changes
  // when the sources themselves do.
  const key = sources?.map((source) => source.index).join(",") ?? null;
  const [held, setHeld] = useState({ key, sources });
  if (held.key !== key) setHeld({ key, sources });
  const messageId = message?.id;
  const request = useMemo(
    () =>
      messageId && held.sources && held.sources.length > 0
        ? sourcesRequest(messageId, held.sources)
        : null,
    [messageId, held.sources],
  );
  useEffect(() => {
    if (request) panel.refresh(request);
    else panel.closeTab(id);
  }, [panel, id, request]);
  return null;
}

/**
 * The detail-panel body for a message's sources. Takes only the source list,
 * which for a completed message is stable. Rows are keyed by the citation
 * index but never show it: the number is the model's handle, not the reader's.
 */
export function SourcesPanelBody({ sources }: { sources: ToolSource[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {sources.map((source) => (
        <SourceRow key={source.index} source={source} />
      ))}
    </ul>
  );
}
