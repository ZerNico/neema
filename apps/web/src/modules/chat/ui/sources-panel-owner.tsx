import { useMemo, useState } from "react";
import { collectSources, selectAnswerSources } from "./citations.ts";
import { NO_INHERITED_SOURCES } from "./inherited-sources.ts";
import type { DisplayMessage } from "./message-list.tsx";
import { SOURCES_PREFIX, sourcesRequest } from "./use-sources-panel.tsx";
import { useDetailPanelTabContent, useDetailPanelTabIds } from "~/ui/detail-panel-context.ts";

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
  useDetailPanelTabContent(id, request);
  return null;
}
