import { File01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { DocumentSource } from "~/modules/tools/source-schema.ts";
import { documentLocationLabel } from "~/modules/tools/sources.ts";
import { useDocumentSourcePanel } from "~/modules/knowledge/ui/document-source-panel.tsx";
import type { ToolSource } from "../client/use-message-stream.ts";
import { IntegrationLogo, integrationName } from "~/modules/integrations/ui/integration-logo.tsx";
import { Favicon, hostOf } from "./favicon.tsx";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "~/ui/hover-card.tsx";

/**
 * An inline citation replacing a GFM footnote reference: the source's favicon
 * and title, linking straight to the page. Citation numbers are an internal
 * handle between model and source list; a reader wants to know what the
 * source is, not which number it was. Hovering previews host and snippet.
 */
export function CitationChip({ source }: { source: ToolSource }) {
  if (source.kind === "document") return <DocumentCitationChip source={source} />;
  return <CitationPreview source={source} />;
}

function DocumentCitationChip({ source }: { source: DocumentSource }) {
  const open = useDocumentSourcePanel(source);
  return <CitationPreview source={source} onClick={open} />;
}

function CitationPreview({ source, onClick }: { source: ToolSource; onClick?: () => void }) {
  const document = source.kind === "document";
  const label = source.title?.trim() || (document ? "Document" : hostOf(source.url));
  const location = document
    ? documentLocationLabel(source)
    : source.kind === "integration"
      ? integrationName(source.integrationId)
      : hostOf(source.url);
  // A connected service's page sits behind the user's sign-in, so its logo
  // stands in for a favicon the server could not fetch anyway.
  const icon = document ? (
    <HugeiconsIcon icon={File01Icon} strokeWidth={2} className="size-3" aria-hidden />
  ) : source.kind === "integration" ? (
    <IntegrationLogo integrationId={source.integrationId} className="size-3" />
  ) : (
    <Favicon url={source.url} className="size-3" />
  );
  const className =
    "bg-muted text-muted-foreground hover:bg-foreground/15 hover:text-foreground hover:ring-foreground/20 focus-visible:ring-ring mx-0.5 inline-flex max-w-48 translate-y-[-1px] items-center gap-1 rounded-full py-0.5 pr-2 pl-1 align-middle text-2xs leading-none font-medium no-underline ring-1 ring-transparent transition-colors duration-100 outline-none select-none focus-visible:ring-2";
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={0}
        closeDelay={100}
        render={
          document ? (
            <button
              type="button"
              onClick={onClick}
              aria-label={`Source: ${label}`}
              className={className}
            />
          ) : (
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={`Source: ${label}`}
              className={className}
            />
          )
        }
      >
        {icon}
        <span className="min-w-0 truncate">{label}</span>
      </HoverCardTrigger>
      <HoverCardContent align="start" sideOffset={8}>
        <div className="text-muted-foreground mb-2 flex min-w-0 items-center gap-2 text-xs">
          {icon}
          <span className="truncate">{location}</span>
        </div>
        <p className="text-sm leading-snug font-medium wrap-anywhere">{label}</p>
        {source.snippet?.trim() ? (
          <p className="text-muted-foreground mt-1.5 line-clamp-3 text-xs leading-relaxed wrap-anywhere">
            {source.snippet}
          </p>
        ) : null}
      </HoverCardContent>
    </HoverCard>
  );
}
