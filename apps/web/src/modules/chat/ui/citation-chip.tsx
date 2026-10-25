import { m } from "~/paraglide/messages.js";
import { File01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import type { DocumentSource } from "~/modules/tools/source-schema.ts";
import { documentLocationLabel } from "~/modules/tools/sources.ts";
import { useDocumentSourcePanel } from "~/modules/knowledge/ui/use-document-source-panel.tsx";
import type { ToolSource } from "../client/use-message-stream.ts";
import { IntegrationLogo } from "~/modules/integrations/ui/integration-logo.tsx";
import { IntegrationNameText } from "~/modules/integrations/ui/integration-mention-text.tsx";
import { Favicon } from "./favicon.tsx";
import { hostOf } from "./host-of.ts";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "~/ui/primitives/hover-card";

const NO_MORE_SOURCES: ReadonlyArray<ToolSource> = [];

/**
 * An inline citation replacing a GFM footnote reference: the source's favicon
 * and site, linking straight to the page; the title waits in the hover card. Citation numbers are an internal
 * handle between model and source list; a reader wants to know what the
 * source is, not which number it was. Hovering previews host and snippet.
 * Adjacent markers arrive as one chip: the first source plus a count, with
 * every source listed, and openable, on hover.
 */
export function CitationChip({
  source,
  more = NO_MORE_SOURCES,
}: {
  source: ToolSource;
  more?: ReadonlyArray<ToolSource>;
}) {
  if (source.kind === "document") return <DocumentCitationChip source={source} more={more} />;
  return <CitationPreview source={source} more={more} />;
}

function DocumentCitationChip({
  source,
  more,
}: {
  source: DocumentSource;
  more: ReadonlyArray<ToolSource>;
}) {
  const open = useDocumentSourcePanel(source);
  return <CitationPreview source={source} more={more} onClick={open} />;
}

const describeSource = (source: ToolSource) => {
  const document = source.kind === "document";
  return {
    label: source.title?.trim() || (document ? m.chat_source_document() : hostOf(source.url)),
    location: document ? (
      documentLocationLabel(source)
    ) : source.kind === "integration" ? (
      <IntegrationNameText integrationId={source.integrationId} />
    ) : (
      hostOf(source.url)
    ),
    // A connected service's page sits behind the user's sign-in, so its logo
    // stands in for a favicon the server could not fetch anyway.
    icon: document ? (
      <HugeiconsIcon icon={File01Icon} strokeWidth={2} className="size-3" aria-hidden />
    ) : source.kind === "integration" ? (
      <IntegrationLogo integrationId={source.integrationId} className="size-3" />
    ) : (
      <Favicon url={source.url} className="size-3" />
    ),
  };
};

function CitationPreview({
  source,
  more,
  onClick,
}: {
  source: ToolSource;
  more: ReadonlyArray<ToolSource>;
  onClick?: () => void;
}) {
  const document = source.kind === "document";
  const { label, icon } = describeSource(source);
  // A page title ran to the chip's limit on every line; the site says enough
  // in passing, as ChatGPT's chips do. Documents and services keep their titles.
  const chipLabel = source.kind === "web" ? hostOf(source.url) : label;
  const name = more.length ? `Sources: ${label} and ${more.length} more` : `Source: ${label}`;
  const className =
    "bg-muted text-muted-foreground hover:bg-foreground/15 hover:text-foreground hover:ring-foreground/20 focus-visible:ring-ring mx-0.5 inline-flex max-w-48 translate-y-[-1px] items-center gap-1 rounded-full py-0.5 pr-2 pl-1 align-middle text-2xs leading-none font-medium no-underline ring-1 ring-transparent transition-colors duration-100 outline-none select-none focus-visible:ring-2";
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={0}
        closeDelay={100}
        render={
          document ? (
            <button type="button" onClick={onClick} aria-label={name} className={className} />
          ) : (
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={name}
              className={className}
            />
          )
        }
      >
        {icon}
        <span className="min-w-0 truncate">{chipLabel}</span>
        {more.length ? <span className="shrink-0 tabular-nums">+{more.length}</span> : null}
      </HoverCardTrigger>
      <HoverCardContent align="start" sideOffset={8}>
        <div className="-m-2 flex flex-col gap-1">
          {[source, ...more].map((each, index) => (
            <SourceRow key={each.index} source={each} excerpt={index === 0} />
          ))}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

const rowClassName =
  "hover:bg-muted focus-visible:ring-ring block w-full rounded-2xl px-2 py-1.5 text-left outline-none focus-visible:ring-2";

/** One source in the preview, opening it the way its chip would. */
function SourceRow({ source, excerpt }: { source: ToolSource; excerpt: boolean }) {
  const { label, location, icon } = describeSource(source);
  const content = (
    <>
      <span className="text-muted-foreground mb-1 flex min-w-0 items-center gap-2 text-xs">
        {icon}
        <span className="truncate">{location}</span>
      </span>
      <span className="block text-sm leading-snug font-medium wrap-anywhere">{label}</span>
      {excerpt && source.snippet?.trim() ? (
        <span className="text-muted-foreground mt-1.5 line-clamp-3 text-xs leading-relaxed wrap-anywhere">
          {source.snippet}
        </span>
      ) : null}
    </>
  );
  if (source.kind === "document")
    return <DocumentSourceRow source={source}>{content}</DocumentSourceRow>;
  return (
    <a href={source.url} target="_blank" rel="noreferrer noopener" className={rowClassName}>
      {content}
    </a>
  );
}

function DocumentSourceRow({ source, children }: { source: DocumentSource; children: ReactNode }) {
  const open = useDocumentSourcePanel(source);
  return (
    <button type="button" onClick={open} className={rowClassName}>
      {children}
    </button>
  );
}
