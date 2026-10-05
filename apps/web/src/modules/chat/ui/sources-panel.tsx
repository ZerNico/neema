import { File01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { DocumentSource } from "~/modules/tools/source-schema.ts";
import { documentLocationLabel } from "~/modules/tools/sources.ts";
import { useDocumentSourcePanel } from "~/modules/knowledge/ui/use-document-source-panel.tsx";
import type { ToolSource } from "../client/use-message-stream.ts";
import { IntegrationLogo } from "~/modules/integrations/ui/integration-logo.tsx";
import { integrationName } from "~/modules/integrations/ui/integration-name.ts";
import { Favicon } from "./favicon.tsx";
import { hostOf } from "./host-of.ts";

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
