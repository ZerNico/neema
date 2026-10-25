import { m } from "~/paraglide/messages.js";
import { FolderLibraryIcon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import type { KnowledgeToolActivity } from "../client/use-message-stream.ts";
import { Disclosure, DisclosureContent, DisclosureTrigger } from "~/ui/disclosure.tsx";
import {
  disclosureBodyRailClassName,
  disclosureTriggerClassName,
} from "~/ui/disclosure-classes.ts";
import { cn } from "~/ui/utils";
import { ActivityChevron, ActivityFace, ActivityNote, ActivityQueries } from "./activity-face.tsx";

/**
 * One collapsed row for a run of knowledge calls, like the web row: the
 * header says what happened in a few words, the disclosure lists what was
 * searched and read. Folded until clicked, as the work line around it is what
 * opens. Reads and listings are counted rather than itemised, since their
 * targets are opaque version ids.
 */
export function KnowledgeActivityBlock({ activities }: { activities: KnowledgeToolActivity[] }) {
  const [expanded, setExpanded] = useState(false);

  if (activities.length === 0) return null;

  const searches = activities.filter((activity) => activity.name === "search_knowledge");
  const reads = activities.filter((activity) => activity.name === "read_knowledge_document");
  const listings = activities.filter((activity) => activity.name === "list_knowledge_documents");
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
      ? m.chat_knowledge_searching()
      : running.name === "read_knowledge_document"
        ? m.chat_knowledge_reading()
        : m.chat_knowledge_listing()
    : allFailed
      ? m.chat_knowledge_failed()
      : searches.length > 0
        ? `${m.chat_knowledge_searched()} · ${m.chat_knowledge_excerpts({ count: excerpts })}`
        : reads.length > 0
          ? m.chat_knowledge_read_excerpts({ count: readExcerpts })
          : m.chat_knowledge_listed();
  const hasDetails = queries.length > 0 || reads.length > 0 || listings.length > 0 || failed > 0;

  return (
    <Disclosure open={expanded} onOpenChange={setExpanded} className="mb-2">
      <DisclosureTrigger className={disclosureTriggerClassName}>
        <ActivityFace
          icon={FolderLibraryIcon}
          label={headerLabel}
          status={running ? "running" : allFailed ? "failed" : "done"}
        />
        {hasDetails ? <ActivityChevron open={expanded} /> : null}
      </DisclosureTrigger>
      {hasDetails ? (
        <DisclosureContent>
          <div className={cn(disclosureBodyRailClassName, "flex flex-col gap-2")}>
            {queries.length > 0 ? (
              <div className="flex flex-col gap-1">
                <ActivityQueries queries={queries} />
                {keywordOnly ? (
                  <p className="text-muted-foreground/70 text-xs">
                    {m.chat_knowledge_keywords_only()}
                  </p>
                ) : null}
              </div>
            ) : null}
            {reads.length > 0 ? (
              <p>{m.chat_knowledge_read_in_full({ count: readExcerpts })}</p>
            ) : null}
            {listings.length > 0 ? (
              <p>
                {m.chat_knowledge_listed_count({
                  count: listings.reduce((t, a) => t + (a.summary?.documentsListed ?? 0), 0),
                })}
              </p>
            ) : null}
            {failed > 0 && !allFailed ? (
              <ActivityNote>{m.chat_knowledge_steps_failed({ count: failed })}</ActivityNote>
            ) : null}
          </div>
        </DisclosureContent>
      ) : null}
    </Disclosure>
  );
}
