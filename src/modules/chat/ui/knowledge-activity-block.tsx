import { ArrowDown01Icon, File01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import type { KnowledgeToolActivity } from "../client/use-message-stream.ts";
import {
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  disclosureBodyRailClassName,
  disclosureChevronMotionClassName,
  disclosureTriggerClassName,
} from "~/ui/disclosure.tsx";
import { cn } from "~/ui/utils";

const COLLAPSE_DELAY_MS = 900;
const QUERY_LIMIT = 6;

const quotedQueries = (queries: ReadonlyArray<string>): string => {
  const visible = queries.slice(0, QUERY_LIMIT).map((query) => `“${query}”`);
  const joined = visible.join(visible.length === 2 ? " and " : ", ");
  return queries.length > QUERY_LIMIT ? `${joined}, +${queries.length - QUERY_LIMIT} more` : joined;
};

/**
 * One collapsed row for a run of knowledge calls, like the web row: the
 * header says what happened in a few words, the disclosure lists what was
 * searched and read. Open while running, closes shortly after, and a manual
 * choice sticks. Reads and listings are counted rather than itemised — their
 * targets are opaque version ids.
 */
export function KnowledgeActivityBlock({ activities }: { activities: KnowledgeToolActivity[] }) {
  const anyRunning = activities.some((activity) => activity.status === "running");
  const [previousRunning, setPreviousRunning] = useState(anyRunning);
  const [graceOpen, setGraceOpen] = useState(anyRunning);
  if (previousRunning !== anyRunning) {
    setPreviousRunning(anyRunning);
    if (anyRunning) setGraceOpen(true);
  }
  useEffect(() => {
    if (anyRunning || !graceOpen) return;
    const timeout = window.setTimeout(() => setGraceOpen(false), COLLAPSE_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [anyRunning, graceOpen]);
  const [override, setOverride] = useState<{ during: boolean; value: boolean } | null>(null);
  const manuallyCollapsedWhileRunning =
    override?.during === true && override.value === false && !anyRunning;
  const expanded =
    override !== null && override.during === anyRunning
      ? override.value
      : manuallyCollapsedWhileRunning
        ? false
        : anyRunning || graceOpen;

  if (activities.length === 0) return null;

  const searches = activities.filter((activity) => activity.name === "search_knowledge");
  const reads = activities.filter((activity) => activity.name === "read_document");
  const listings = activities.filter((activity) => activity.name === "list_documents");
  const queries = [...new Set(searches.flatMap((activity) => activity.summary?.targets ?? []))];
  const excerpts = searches.reduce(
    (total, activity) => total + (activity.summary?.passagesReturned ?? 0),
    0,
  );
  const readExcerpts = reads.reduce(
    (total, activity) => total + (activity.summary?.passagesReturned ?? 0),
    0,
  );
  const failed = activities.filter((activity) => activity.status === "error").length;
  const allFailed = failed === activities.length;
  const keywordOnly = searches.some((activity) => activity.summary?.mode === "lexical");
  const running = activities.find((activity) => activity.status === "running");

  const headerLabel = running
    ? running.name === "search_knowledge"
      ? "Searching documents…"
      : running.name === "read_document"
        ? "Reading documents…"
        : "Listing documents…"
    : allFailed
      ? "Documents unavailable"
      : searches.length > 0
        ? `Searched documents · ${excerpts} ${excerpts === 1 ? "excerpt" : "excerpts"}`
        : reads.length > 0
          ? `Read ${readExcerpts} ${readExcerpts === 1 ? "excerpt" : "excerpts"}`
          : "Listed documents";
  const hasDetails = queries.length > 0 || reads.length > 0 || listings.length > 0 || failed > 0;

  return (
    <Disclosure
      open={expanded}
      onOpenChange={(next) => setOverride({ during: anyRunning, value: next })}
      className="mb-2"
    >
      <DisclosureTrigger className={disclosureTriggerClassName}>
        <HugeiconsIcon icon={File01Icon} className="size-4" aria-hidden />
        <span className={cn(anyRunning && "text-shimmer")}>{headerLabel}</span>
        {hasDetails ? (
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            className={cn(disclosureChevronMotionClassName, "size-3.5", expanded && "rotate-180")}
          />
        ) : null}
      </DisclosureTrigger>
      {hasDetails ? (
        <DisclosureContent>
          <div className={cn(disclosureBodyRailClassName, "flex flex-col gap-2")}>
            {queries.length > 0 ? (
              <p>
                Searched <span className="text-foreground/70">{quotedQueries(queries)}</span>
                {keywordOnly ? (
                  <span className="text-muted-foreground/70"> · keyword search</span>
                ) : null}
              </p>
            ) : null}
            {reads.length > 0 ? (
              <p>
                Read {readExcerpts} {readExcerpts === 1 ? "excerpt" : "excerpts"} in full
              </p>
            ) : null}
            {listings.length > 0 ? (
              <p>
                Listed {listings.reduce((t, a) => t + (a.summary?.documentsListed ?? 0), 0)}{" "}
                documents
              </p>
            ) : null}
            {failed > 0 && !allFailed ? (
              <p className="text-destructive text-xs">
                {failed === 1 ? "One step failed." : `${failed} steps failed.`}
              </p>
            ) : null}
          </div>
        </DisclosureContent>
      ) : null}
    </Disclosure>
  );
}
